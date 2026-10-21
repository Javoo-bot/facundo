// Sanitiser for staff-authored rich text in the message editor.
//
// This is a security boundary before it is a feature. Every string in this
// product currently reaches an email through `escapeHtml`, so markup is
// impossible by construction. Letting the editor produce bold and links means
// deliberately removing that guarantee for those fields — and the output is
// mail we send to third parties, so what survives has to be an allowlist, not
// a blocklist.
//
// Applied TWICE on purpose: on the way in (when a draft is saved) and again on
// the way out (when a message renders). Sanitising only on save trusts every
// row already in the database, including anything written before a rule
// changed; sanitising only on render trusts the editor to have been the only
// writer. Neither assumption is worth betting an outbound email on.
//
// The input is not authored HTML, it is whatever a browser's contenteditable
// surface (and paste from Word/Google Docs) happens to emit. That HTML is
// full of markup that carries no attack and no attempt to escape the
// allowlist, it is just how browsers spell the formatting we already support:
// <div>/<p> for line breaks, <span style="font-weight:bold"> for bold, nbsp
// for a space. Treating all of that as "not on the allowlist" and escaping it
// into visible text (the correct response to an actual attack) would look, to
// the author, like the editor mangling every paste. So this file does two
// different things to two different kinds of input: markup that carries
// meaning we support gets NORMALISED into the allowed vocabulary; markup that
// carries no meaning we support (or that we don't want, like <style> blocks
// or comments) gets DROPPED; only markup we don't recognise at all still gets
// escaped into visible text, so a genuine rejection stays visible.
//
// Relative imports only, so `node --test` can reach it.

/** Tags a staff editor may use. Deliberately tiny: emphasis and links are the
 * whole ask. No block-level tags — the block MODEL owns structure, so a <div>
 * or <table> here would let one field silently restructure an email. This is
 * also the complete set of tags this sanitiser ever EMITS: <span> and <font>
 * are recognised on input and normalised away, they never appear in output. */
const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "a", "br"]);

/** Schemes a link may use. `javascript:` and `data:` are the obvious attacks;
 * everything not on this list is dropped rather than guessed at. */
const ALLOWED_SCHEMES = ["http://", "https://", "mailto:"];

const VOID_TAGS = new Set(["br"]);

/** Entity-AWARE escape. A plain `&` -> `&amp;` escape is not idempotent, and
 * this sanitiser runs twice by design (on save and at render): a second pass
 * would turn `&lt;script&gt;` into `&amp;lt;script&amp;gt;`, and the author's
 * text would visibly rot every time it was saved. So an `&` that already
 * begins a valid entity is left alone. */
const ENTITY = /&(?:amp|lt|gt|quot|#39|#x27|nbsp|#\d+);/iy;

export function escapeHtml(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "&") {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(s);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
      out += "&amp;";
      continue;
    }
    if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === '"') out += "&quot;";
    else if (c === "'") out += "&#39;";
    else out += c;
  }
  return out;
}

function safeHref(raw: string): string | null {
  // Strip whitespace and control characters first: "java\nscript:alert(1)" and
  // "  javascript:..." both parse as javascript: in a browser.
  const cleaned = raw.replace(/[ - ]/g, "").toLowerCase();
  if (!ALLOWED_SCHEMES.some((s) => cleaned.startsWith(s))) return null;
  return raw.trim();
}

// ---- normalising the emphasis vocabulary (literal tags AND <span style>) ----
//
// A browser spells "bold" three ways we have to accept: <b>, <strong>, and
// <span style="font-weight:bold"> (or 700/800/900, what execCommand and
// pasted Word/Docs content actually produce). Google Docs additionally wraps
// its ENTIRE clipboard payload in <b style="font-weight:normal" id="docs-...">
// as a reset, so a literal <b> can mean "not bold" if its own style says so.
// Modelling this as one "bold" bucket that literal tags, span styles, and
// style-negation all feed into, rather than three separate cases, is what
// makes the Docs wrapper (bold tag, explicitly turned off) fall out for free
// instead of needing its own special case.
type Bucket = "bold" | "italic" | "underline";
const BUCKET_ORDER: Bucket[] = ["bold", "italic", "underline"];
const DEFAULT_SPELLING: Record<Bucket, string> = { bold: "b", italic: "i", underline: "u" };

function styleAttr(rawTag: string): string {
  const m = /style\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawTag);
  return (m ? (m[2] ?? m[3] ?? m[4] ?? "") : "").toLowerCase();
}

/** What a <span style="..."> maps to. No match on any recognised property
 * means the span "contributes nothing but keeps its children": it is
 * transparent, not an error, because a plain <span> (or one styling only
 * color/font-family, which we don't support) is extremely common in paste. */
function spanBuckets(style: string): Bucket[] {
  const buckets: Bucket[] = [];
  if (/font-weight\s*:\s*(bold|[7-9]00)\b/.test(style)) buckets.push("bold");
  if (/font-style\s*:\s*italic\b/.test(style)) buckets.push("italic");
  if (/text-decoration(-line)?\s*:[^;]*\bunderline\b/.test(style)) buckets.push("underline");
  return buckets;
}

/** Whether a literal tag's own style explicitly turns its formatting back
 * off, e.g. Google Docs' <b style="font-weight:normal" id="docs-internal-guid-...">
 * wrapper around its whole clipboard payload. Without this, the entire pasted
 * email would render bold, since the wrapper is a real, allowed <b> tag and we
 * otherwise strip style without reading it. */
function isBucketNegated(bucket: Bucket, style: string): boolean {
  if (!style) return false;
  if (bucket === "bold") return /font-weight\s*:\s*(normal|lighter|[1-6]00)\b/.test(style);
  if (bucket === "italic") return /font-style\s*:\s*normal\b/.test(style);
  // underline: only negated by an EXPLICIT text-decoration that doesn't say
  // underline (e.g. "none", or "line-through" alone), the absence of the
  // property says nothing.
  const m = /text-decoration(-line)?\s*:\s*([^;]*)/.exec(style);
  return m ? !/underline/.test(m[2]) : false;
}

type Frame = { source: string; tags: string[]; buckets: Bucket[] };

/** Sanitise one field of staff-authored rich text.
 *
 * Genuinely unrejected input becomes escaped TEXT rather than being dropped:
 * if someone pastes `<script>alert(1)</script>`, showing them
 * `<script>alert(1)</script>` as literal text makes the rejection visible,
 * whereas silently deleting it looks like the editor ate their work. That
 * only applies to markup we don't understand at all, though, see the file
 * header for why <div>/<p>/<span>/font/&nbsp; get normalised instead, and why
 * <meta>/<style>/comments get dropped silently (visibly escaping a wall of
 * Word CSS would be worse than either alternative). */
export function sanitizeRichText(input: string): string {
  // Browsers spell a plain space as &nbsp; constantly inside contenteditable.
  // Doing this as a pre-pass, rather than teaching escapeHtml about it, keeps
  // the entity-escaping logic (which is about idempotency of already-escaped
  // output) separate from this normalisation concern, and is trivially
  // idempotent itself: the second pass never sees "&nbsp;" again, because the
  // first pass already turned it into a literal space.
  input = input.replace(/&nbsp;/gi, " ");

  let out = "";
  let i = 0;
  const open: Frame[] = [];

  // Per-bucket "how many currently-open tags want this formatting" counters.
  // This is what collapses <b><b>x</b></b> into <b>x</b>: the inner <b> sees
  // the bucket is already open and contributes nothing, so only the frame
  // that took the count from 0 to 1 ever emits a tag, and only the frame that
  // takes it back to 0 ever emits the close. It is also what makes a <span
  // style="font-weight:bold"> nested inside a literal <b> a no-op instead of
  // a redundant second <b>.
  const bucketCount: Record<Bucket, number> = { bold: 0, italic: 0, underline: 0 };
  const activeSpelling: Record<Bucket, string> = { bold: "b", italic: "i", underline: "u" };

  // <div>/<p> mark line boundaries, not visible structure: browsers wrap
  // every line of a contenteditable in one. A boundary only becomes a real
  // <br /> when there turns out to be content before AND after it, that is
  // what keeps a leading or trailing block tag from adding a stray break, and
  // what keeps a run of pure whitespace between block tags (typical of a
  // Word/Docs paste, which is pretty-printed) from becoming visible text.
  let pendingBreak = false;

  function emit(str: string): void {
    if (str.length === 0) return;
    if (pendingBreak) {
      if (/^\s*$/.test(str)) return; // structural whitespace, not authored content: don't consume the pending break on it
      pendingBreak = false;
      if (out.length > 0) out += "<br />";
    }
    out += str;
  }

  function openBuckets(buckets: Bucket[], spellings: Partial<Record<Bucket, string>>): void {
    for (const b of buckets) {
      bucketCount[b] += 1;
      if (bucketCount[b] === 1) {
        const spelling = spellings[b] ?? DEFAULT_SPELLING[b];
        activeSpelling[b] = spelling;
        emit(`<${spelling}>`);
      }
    }
  }

  function closeFrame(frame: Frame): void {
    for (let k = frame.tags.length - 1; k >= 0; k -= 1) emit(`</${frame.tags[k]}>`);
    for (let k = frame.buckets.length - 1; k >= 0; k -= 1) {
      const b = frame.buckets[k];
      bucketCount[b] -= 1;
      if (bucketCount[b] === 0) emit(`</${activeSpelling[b]}>`);
    }
  }

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      emit(escapeHtml(input.slice(i)));
      break;
    }
    emit(escapeHtml(input.slice(i, lt)));

    // Comments can contain ">" (e.g. Word's conditional comments), so they
    // have to be recognised before we go looking for the tag's ">". Dropped
    // wholesale, not shown: a Word/Docs paste can carry a comment full of
    // internal metadata that has no business appearing in an email.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      // Unterminated "<": it is text, not a tag.
      emit(escapeHtml(input.slice(lt)));
      break;
    }

    const rawTag = input.slice(lt + 1, gt).trim();
    const isClose = rawTag.startsWith("/");
    const name = (isClose ? rawTag.slice(1) : rawTag).split(/[\s/]/)[0].toLowerCase();

    if (name === "div" || name === "p") {
      // No stack entry needed: these never emit a real tag, so they can
      // never be "unbalanced" the way an unclosed <b> can.
      pendingBreak = true;
      i = gt + 1;
      continue;
    }

    if (name === "meta") {
      // Void in practice; dropped rather than shown, same reasoning as <style>.
      i = gt + 1;
      continue;
    }

    if (name === "style") {
      if (isClose) {
        // Stray close with no matching open: nothing to do.
        i = gt + 1;
        continue;
      }
      // Drop the whole block, not just the tags: showing the CSS as escaped
      // text would dump a wall of Word/Docs styling into the message.
      const closeTag = /<\/style\s*>/i.exec(input.slice(gt + 1));
      i = closeTag ? gt + 1 + closeTag.index + closeTag[0].length : input.length;
      continue;
    }

    const isStructuralWrapper = name === "span" || name === "font";

    if (!ALLOWED_TAGS.has(name) && !isStructuralWrapper) {
      // Genuinely unknown (script, table, img, strike, sub, sup, ...): keep
      // the existing behaviour of showing the rejection as visible text
      // rather than silently eating it.
      emit(escapeHtml(input.slice(lt, gt + 1)));
      i = gt + 1;
      continue;
    }

    if (isClose) {
      // Only close a frame we actually opened, and close everything above it
      // too, in order, otherwise a stray </b> could terminate markup this
      // field never started, and an interleaved <b><i>x</b></i> would leak
      // an unmatched </i> past the field.
      const idx = open.map((f) => f.source).lastIndexOf(name);
      if (idx !== -1) {
        while (open.length > idx) closeFrame(open.pop()!);
      }
      i = gt + 1;
      continue;
    }

    if (VOID_TAGS.has(name)) {
      // An explicit <br> already IS the line break; if one lands right after
      // a <div>/<p> boundary (the standard "<div><br></div>" a browser uses
      // for a blank line) it should not also flush a synthetic break, or a
      // single blank line would render as two.
      pendingBreak = false;
      out += "<br />";
      i = gt + 1;
      continue;
    }

    if (name === "a") {
      // The ONLY attribute allowed anywhere, on the only tag that takes one.
      // Everything else in the source tag is discarded: no style (inline CSS
      // smuggles tracking and worse), no on* handlers, no class/id, and
      // target/rel are set by us rather than by the author.
      const m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawTag);
      const href = m ? safeHref(m[2] ?? m[3] ?? m[4] ?? "") : null;
      if (!href) {
        // A link with no usable target is emphasis at best; keep the text,
        // drop the anchor, rather than emit a dead or dangerous href.
        i = gt + 1;
        continue;
      }
      emit(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`);
      open.push({ source: "a", tags: ["a"], buckets: [] });
      i = gt + 1;
      continue;
    }

    if (name === "font") {
      // Drop entirely, children kept: <font> carries no formatting we
      // support (color/face/size), so unwrap it rather than reject it.
      open.push({ source: "font", tags: [], buckets: [] });
      i = gt + 1;
      continue;
    }

    const style = styleAttr(rawTag);
    let buckets: Bucket[];
    const spellings: Partial<Record<Bucket, string>> = {};

    if (name === "span") {
      buckets = spanBuckets(style);
    } else {
      // A literal emphasis tag (b/strong/i/em/u): base formatting comes from
      // the tag itself; an explicit contradicting style (the Docs
      // "font-weight:normal" wrapper) turns it back off instead.
      const bucket: Bucket = name === "b" || name === "strong" ? "bold" : name === "i" || name === "em" ? "italic" : "underline";
      const negated = isBucketNegated(bucket, style);
      buckets = negated ? [] : [bucket];
      if (!negated) spellings[bucket] = name; // preserve the author's spelling (<strong> stays <strong>)
    }

    buckets = BUCKET_ORDER.filter((b) => buckets.includes(b));
    openBuckets(buckets, spellings);
    open.push({ source: name, tags: [], buckets });
    i = gt + 1;
  }

  // Never hand back unbalanced markup: an unclosed <b> would bold the rest of
  // the email, not just this field. A trailing pendingBreak is simply
  // dropped: nothing followed the last block boundary, so it's not a break.
  while (open.length) closeFrame(open.pop()!);
  return out;
}

/** The plain-text alternative for a rich-text field. Derived by stripping,
 * never authored separately, so a text-only mail client can't be shown
 * something the HTML part doesn't say. */
export function richTextToPlain(input: string): string {
  return sanitizeRichText(input)
    .replace(/<br \/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** True when the input contains markup this sanitiser would keep. Used by the
 * editor to decide whether a field needs the rich-text control at all. */
export function hasRichText(input: string): boolean {
  return sanitizeRichText(input) !== escapeHtml(input);
}
