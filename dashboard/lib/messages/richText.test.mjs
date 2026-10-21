import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeRichText, richTextToPlain, hasRichText } from "./richText.ts";

// ---- what staff are allowed to do ----

test("keeps the emphasis tags the editor offers", () => {
  assert.equal(sanitizeRichText("<b>bold</b> and <em>italic</em> and <u>under</u>"), "<b>bold</b> and <em>italic</em> and <u>under</u>");
  assert.equal(sanitizeRichText("line<br>break"), "line<br />break");
});

test("keeps a safe link, and hardens it", () => {
  const out = sanitizeRichText('<a href="https://fc.example.com">shop</a>');
  assert.ok(out.includes('href="https://fc.example.com"'));
  assert.ok(out.includes('rel="noopener noreferrer"'));
  assert.ok(out.includes('target="_blank"'));
});

test("mailto links are allowed", () => {
  assert.ok(sanitizeRichText('<a href="mailto:x@y.com">mail</a>').includes("mailto:x@y.com"));
});

// ---- the security boundary ----
// This output goes into email we send to third parties, so each of these is a
// real hazard rather than a tidiness rule.

test("script tags become visible text, not markup", () => {
  const out = sanitizeRichText("<script>alert(1)</script>hi");
  assert.ok(!out.includes("<script"), out);
  assert.ok(out.includes("&lt;script&gt;"), "the rejection should be visible to the author");
  assert.ok(out.includes("hi"));
});

test("javascript: and data: hrefs are dropped, keeping the text", () => {
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x", "vbscript:x"]) {
    const out = sanitizeRichText(`<a href="${bad}">click</a>`);
    assert.ok(!out.includes("<a"), `${bad} produced an anchor: ${out}`);
    assert.ok(out.includes("click"), "link text should survive");
  }
});

test("a scheme hidden with whitespace or control characters is still caught", () => {
  // A browser parses "java\nscript:" as javascript:, so a naive startsWith on
  // the raw string is not enough.
  for (const bad of [" javascript:alert(1)", "java\nscript:alert(1)", "java\tscript:alert(1)", "javascript:alert(1)"]) {
    const out = sanitizeRichText(`<a href="${bad}">click</a>`);
    assert.ok(!out.includes("<a"), `${JSON.stringify(bad)} produced an anchor: ${out}`);
  }
});

test("event handlers, style and other attributes are stripped", () => {
  const out = sanitizeRichText('<b onclick="steal()" style="position:fixed" class="x">t</b>');
  assert.equal(out, "<b>t</b>");
  const link = sanitizeRichText('<a href="https://x.test" onmouseover="x()" style="a:b">t</a>');
  assert.ok(!/onmouseover|style=/.test(link), link);
});

test("block-level and structural tags are refused", () => {
  // The block MODEL owns structure; a <div> or <table> in one field would let
  // it silently restructure the whole email.
  for (const tag of ["div", "table", "tr", "td", "img", "iframe", "style", "meta", "form", "input"]) {
    const out = sanitizeRichText(`<${tag}>x</${tag}>`);
    assert.ok(!out.includes(`<${tag}>`), `${tag} survived: ${out}`);
  }
});

test("unbalanced markup can never leak past the field", () => {
  // An unclosed <b> would otherwise bold the rest of the email.
  assert.equal(sanitizeRichText("<b>oops"), "<b>oops</b>");
  // A stray close tag must not terminate markup this field never opened.
  assert.equal(sanitizeRichText("</b>plain"), "plain");
  assert.equal(sanitizeRichText("<b><i>x</b></i>"), "<b><i>x</i></b>");
});

test("an unterminated < is treated as text", () => {
  assert.equal(sanitizeRichText("5 < 6"), "5 &lt; 6");
  assert.equal(sanitizeRichText("a <b"), "a &lt;b");
});

test("plain text is escaped, so it can never become markup", () => {
  assert.equal(sanitizeRichText('a & b "c" <d>'), "a &amp; b &quot;c&quot; &lt;d&gt;");
});

test("sanitising twice changes nothing (it runs on save AND at render)", () => {
  for (const input of ['<b>x</b>', '<script>alert(1)</script>', '<a href="https://x.test">t</a>', "5 < 6", "<b>oops"]) {
    const once = sanitizeRichText(input);
    assert.equal(sanitizeRichText(once), once, `not idempotent for ${input}`);
  }
});

// ---- plain-text alternative ----

test("the plain-text alternative is derived, never markup", () => {
  assert.equal(richTextToPlain("<b>bold</b> and <a href='https://x.test'>link</a>"), "bold and link");
  assert.equal(richTextToPlain("one<br>two"), "one\ntwo");
  // Refused markup stays visible as TEXT in both parts, so the plain
  // alternative says exactly what the HTML part says. Plain text is never
  // parsed as HTML, so echoing it back is safe as well as consistent.
  assert.equal(richTextToPlain("<script>alert(1)</script>"), "<script>alert(1)</script>");
  assert.ok(!richTextToPlain('<b>x</b> & "y"').includes("&amp;"));
});

test("hasRichText only reports markup that would actually survive", () => {
  assert.ok(hasRichText("<b>x</b>"));
  assert.ok(!hasRichText("plain text"));
  assert.ok(!hasRichText("<script>x</script>"), "refused markup is not rich text");
  assert.ok(!hasRichText("5 < 6"));
});

// ---- normalising what browsers actually emit from contenteditable/paste ----
// The editor's toolbar only ever asks for bold/italic/underline/link, but the
// DOM it produces (and whatever a user pastes into it) is generated by the
// browser, not by the toolbar. If this sanitiser treats that HTML the same
// way it treats an XSS attempt, i.e. escapes it into visible `&lt;div&gt;`
// junk, every ordinary paste looks like the editor mangled the author's text.

test("div/p line wrapping becomes a line break, not visible text", () => {
  // Chrome/Safari wrap every line of a contenteditable in its own <div> or
  // <p>. Left un-normalised, saving a two-line message would show the author
  // "Line one&lt;div&gt;Line two&lt;/div&gt;" instead of two lines.
  assert.equal(sanitizeRichText("<div>Line one</div><div>Line two</div>"), "Line one<br />Line two");
  assert.equal(sanitizeRichText("<p>a</p><p>b</p>"), "a<br />b");
});

test("a lone div/p never adds a leading or trailing break", () => {
  // A single-line message is still wrapped in one <div> by the browser. If a
  // block boundary always emitted a break, every message would render with a
  // stray blank line before or after it, forever.
  assert.equal(sanitizeRichText("<div>only one line</div>"), "only one line");
  assert.equal(sanitizeRichText("<p>a</p>"), "a");
});

test("an empty <div><br></div> (a browser's blank line) becomes exactly one blank line", () => {
  // Chrome represents a blank line the author left between paragraphs as an
  // empty div containing just a <br>. If the div boundary and the explicit
  // <br> both emitted a break, one blank line in the editor would turn into
  // two by the time it reached the recipient's inbox.
  const out = sanitizeRichText("<div>Hi there</div><div><br></div><div>Second line</div>");
  assert.equal(out, "Hi there<br /><br />Second line");
});

test("span style attributes map to the emphasis tags they visually mean", () => {
  // execCommand('bold') and pasted Word/Docs content don't write <b>, they
  // write <span style="font-weight:bold">. Without this mapping, every bold
  // word a user actually typed in the editor would come out as plain text.
  assert.equal(sanitizeRichText('<span style="font-weight:bold">x</span>'), "<b>x</b>");
  assert.equal(sanitizeRichText('<span style="font-weight:700">x</span>'), "<b>x</b>");
  assert.equal(sanitizeRichText('<span style="font-weight:900">x</span>'), "<b>x</b>");
  assert.equal(sanitizeRichText('<span style="font-style:italic">x</span>'), "<i>x</i>");
  assert.equal(sanitizeRichText('<span style="text-decoration:underline">x</span>'), "<u>x</u>");
  // A span can carry more than one at once (Word commonly does).
  assert.equal(sanitizeRichText('<span style="font-weight:bold;text-decoration:underline">x</span>'), "<b><u>x</u></b>");
});

test("a span whose style doesn't say bold/italic/underline is transparent", () => {
  // The overwhelming majority of spans in real paste carry font-family,
  // color, or font-size, none of which this editor supports. If an
  // unrecognised span were rejected instead of unwrapped, pasting a Word
  // document would turn every word into visible `&lt;span ...&gt;` noise.
  assert.equal(sanitizeRichText('<span style="color:red">x</span>'), "x");
  assert.equal(sanitizeRichText("<span>x</span>"), "x");
  // font-weight:400 / normal is explicitly NOT bold.
  assert.equal(sanitizeRichText('<span style="font-weight:400">x</span>'), "x");
  assert.equal(sanitizeRichText('<span style="text-decoration:none">x</span>'), "x");
});

test("a literal <b> can be turned back off by its own style (the Google Docs wrapper)", () => {
  // Google Docs wraps its ENTIRE clipboard payload in
  // <b style="font-weight:normal" id="docs-internal-guid-...">. It is a real,
  // allowed <b> tag; if we kept it (as the old attribute-stripping logic
  // would, since it discards style without reading it) every Docs paste
  // would render the whole message bold, which is the opposite of what the
  // wrapper is for.
  assert.equal(sanitizeRichText('<b style="font-weight:normal">plain</b>'), "plain");
  assert.equal(sanitizeRichText('<strong style="font-weight:normal">plain</strong>'), "plain");
  assert.equal(sanitizeRichText('<i style="font-style:normal">plain</i>'), "plain");
  // But a <b> with an unrelated style is still bold, matching the existing
  // "other attributes are stripped, tag survives" behaviour.
  assert.equal(sanitizeRichText('<b style="color:red">x</b>'), "<b>x</b>");
});

test("&nbsp; becomes a normal space", () => {
  // Contenteditable inserts &nbsp; constantly (e.g. for a trailing space at
  // end of line, which browsers refuse to render as a plain space). Left as
  // the literal entity, the author would see the six characters "&nbsp;" in
  // their message rather than a space.
  assert.equal(sanitizeRichText("a&nbsp;b"), "a b");
  assert.equal(sanitizeRichText("a&NBSP;b"), "a b");
});

test("<font> is dropped but its content is kept", () => {
  // Pasted legacy HTML (old email signatures, old Word exports) still uses
  // <font color/face/size>, none of which this editor supports. Rejecting it
  // outright would delete the author's words along with the tag; unwrapping
  // it keeps the words and just drops formatting we never offered.
  assert.equal(sanitizeRichText("<font color=\"red\" face=\"Arial\">hello</font>"), "hello");
});

test("<meta>, <style>, and comments are removed rather than shown as text", () => {
  // A paste from Word or Google Docs carries a <meta charset> tag and often a
  // <style> block full of CSS class definitions. Escaping that block into
  // visible text (the treatment a genuinely unknown tag gets) would dump a
  // wall of CSS into the message body instead of quietly disappearing.
  assert.equal(sanitizeRichText('<meta charset="utf-8">hello'), "hello");
  assert.equal(sanitizeRichText("<style>.c1{font-weight:700;color:red}</style>hello"), "hello");
  assert.equal(sanitizeRichText("<!-- [if gte mso 9]>garbage<![endif] -->hello"), "hello");
  // An unterminated <style> (a paste truncated mid-tag) drops to the end
  // rather than leaking the rest of the CSS as visible text.
  assert.equal(sanitizeRichText("before<style>.c1{color:red"), "before");
});

test("redundant nesting collapses instead of piling up empty tags", () => {
  // Browsers sometimes double-wrap formatting (e.g. toggling bold twice
  // during editing, or a <span style="font-weight:bold"> pasted inside an
  // already-bold selection). The visible result is identical either way, so
  // the surviving markup should be too, rather than emailing out
  // <b><b><b>x</b></b></b>-shaped nesting nobody asked for.
  assert.equal(sanitizeRichText("<b><b>x</b></b>"), "<b>x</b>");
  assert.equal(sanitizeRichText("<b><strong>x</strong></b>"), "<b>x</b>");
  assert.equal(sanitizeRichText('<b><span style="font-weight:bold">x</span></b>'), "<b>x</b>");
});

test("tags this editor never offered (strike/sub/sup) still show as visible text", () => {
  // The toolbar only offers bold/italic/underline/link; strikethrough,
  // subscript, and superscript aren't features of this editor. They fall
  // back to the same "genuinely unknown" treatment as <script> or <table>:
  // visible, not silently eaten, so a paste that included them doesn't look
  // like content vanished.
  assert.ok(sanitizeRichText("<strike>x</strike>").includes("&lt;strike&gt;"));
  assert.ok(sanitizeRichText("<sub>x</sub>").includes("&lt;sub&gt;"));
  assert.ok(sanitizeRichText("<sup>x</sup>").includes("&lt;sup&gt;"));
});

test("a real Google Docs paste blob normalises to the intended formatting, nothing else", () => {
  // This is an actual shape of clipboard HTML Google Docs produces: a
  // <meta charset>, the whole body wrapped in a bold-reset <b>, a <p> for the
  // paragraph, and per-run <span style="..."> carrying a dozen CSS
  // properties alongside the one or two that matter. If any piece of this is
  // handled wrong, the author sees either a wall of escaped CSS, the whole
  // paragraph rendered bold, or the paragraph break silently eaten.
  const gdocs =
    '<meta charset="utf-8">' +
    '<b style="font-weight:normal;" id="docs-internal-guid-abc123-xyz">' +
    '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' +
    '<span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:700;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Hello </span>' +
    '<span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:italic;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">world</span>' +
    "</p></b>";
  assert.equal(sanitizeRichText(gdocs), "<b>Hello </b><i>world</i>");
});

test("a real Chrome contenteditable blob (div line wrapping + nbsp) normalises cleanly", () => {
  // What actually lands in the DB when a staffer types two lines in a Chrome
  // contenteditable field, bolds a word, and hits the space bar at end of
  // line (which Chrome renders as &nbsp;).
  const chrome = "<div>Hi&nbsp;there</div><div>Second line with <b>bold</b> word</div>";
  assert.equal(sanitizeRichText(chrome), "Hi there<br />Second line with <b>bold</b> word");
});

test("normalisation is idempotent for every new case, same guarantee as the security boundary", () => {
  // This runs on save AND at render (see file header). If any of the new
  // normalisation rules weren't stable under a second pass, the author's
  // message would keep changing shape every time it was re-saved.
  const inputs = [
    "<div>Line one</div><div>Line two</div>",
    "<div>only one line</div>",
    "<div>Hi there</div><div><br></div><div>Second line</div>",
    '<span style="font-weight:bold;text-decoration:underline">x</span>',
    '<span style="color:red">x</span>',
    '<b style="font-weight:normal">plain</b>',
    "a&nbsp;b",
    "<font color=\"red\">hello</font>",
    '<meta charset="utf-8">hello',
    "<style>.c1{color:red}</style>hello",
    "<!-- comment -->hello",
    "<b><b>x</b></b>",
    "<b><strong>x</strong></b>",
    "<strike>x</strike>",
    'before<style>.c1{color:red',
  ];
  for (const input of inputs) {
    const once = sanitizeRichText(input);
    const twice = sanitizeRichText(once);
    assert.equal(twice, once, `not idempotent for ${JSON.stringify(input)}: ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`);
  }
});

test("normalisation never reopens the security boundary", () => {
  // The new tags (span, font, div, p) get their own code path; make sure
  // that path can't be used to smuggle an attribute back onto an allowed
  // tag, or a dangerous scheme through a span-derived anything (spans never
  // carry an href, but this pins that a style attribute can't leak either).
  assert.equal(sanitizeRichText('<span style="font-weight:bold" onclick="steal()">x</span>'), "<b>x</b>");
  assert.equal(sanitizeRichText('<div onclick="steal()">x</div>'), "x");
  assert.ok(!sanitizeRichText('<span style="font-weight:bold">x</span>').includes("onclick"));
});
