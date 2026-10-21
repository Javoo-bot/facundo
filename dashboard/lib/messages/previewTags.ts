// Makes rendered output traceable back to the catalog key that produced each
// piece of it, so the editor can map a click in the preview to a field.
//
// The obvious approach — thread the key through every render call — would mean
// editing every builder and every helper in lib/emailTemplate.ts, and would put
// preview-only concerns into the code path that does real sends.
//
// Instead we exploit a property `tWithOverrides` already has: it prefers
// `overrides[key]` over the catalog and interpolates whatever it finds. Hand it
// a Proxy that answers EVERY key with the resolved value wrapped in sentinels,
// and every builder emits tagged output with no changes at all — while
// `{placeholder}` interpolation keeps working, because it runs over the wrapped
// string and the sentinels are not `{...}`.
//
// Sentinels are C0 control characters: they cannot appear in catalog copy, they
// survive escapeHtml untouched (it only rewrites & < > " '), and they are
// trivially strippable from plain-text parts.
import { staticLookup, DEFAULT_LOCALE, type Locale } from "../i18n/index.ts";

export const SENTINEL_START = "\u0001";
export const SENTINEL_SEP = "\u0002";
export const SENTINEL_END = "\u0003";

/** True if `s` carries a preview marker. Used by the guard test that asserts a
 * REAL send never does. */
export function hasSentinel(s: string): boolean {
  return s.includes(SENTINEL_START);
}

/** An overrides map that tags every lookup with its key.
 *
 * `base` is the real overrides map (published + any in-flight draft edits), so
 * the preview shows exactly what a send would produce with those values.
 *
 * Returns `undefined` for a key that resolves nowhere, so `tWithOverrides`
 * falls through to `t()` and keeps its existing "echo the key back" behaviour
 * for a genuinely missing key rather than rendering an empty tagged span. */
export function previewOverrides(base: Record<string, string>, locale: Locale): Record<string, string> {
  return new Proxy(
    {},
    {
      get(_target, prop: string | symbol): string | undefined {
        if (typeof prop !== "string") return undefined;
        const resolved = base[prop] ?? staticLookup(locale, prop) ?? staticLookup(DEFAULT_LOCALE, prop);
        if (resolved === undefined) return undefined;
        return `${SENTINEL_START}${prop}${SENTINEL_SEP}${resolved}${SENTINEL_END}`;
      },
      // Keep `in` / Object.keys honest-ish for anything that probes the map.
      has(_target, prop) {
        return typeof prop === "string";
      },
    }
  ) as Record<string, string>;
}

/** Remove all markers, leaving the plain value. For subjects, plain-text email
 * bodies, and SMS/push copy — anywhere the output isn't HTML. */
export function stripSentinels(text: string): string {
  // A scanner, not a regex: markers NEST. The offer SMS interpolates an
  // already-tagged deadline fragment into an already-tagged body, and a
  // non-greedy regex closes the outer marker on the inner terminator, leaving
  // stray control characters in the output.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === SENTINEL_START) {
      const sep = text.indexOf(SENTINEL_SEP, i);
      if (sep === -1) {
        i += 1; // malformed: drop the control character
        continue;
      }
      i = sep + 1; // skip past the key
      continue;
    }
    if (ch === SENTINEL_SEP || ch === SENTINEL_END) {
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Convert markers in rendered HTML into `<span data-fc-key="…">` wrappers.
 *
 * Only markers in TEXT position become spans. A catalog string interpolated
 * into an attribute (a CTA label used as `title=`, say) is unwrapped in place —
 * injecting a tag inside an attribute value would produce broken HTML, which is
 * exactly the kind of thing that would only show up in one email months later.
 *
 * The scan tracks whether it is inside a `<...>` tag rather than using a regex
 * over the whole document, because the values themselves can contain anything. */
export function tagPreviewHtml(html: string): string {
  let out = "";
  let i = 0;
  let inTag = false;
  // Depth of open <span> wrappers, so nested markers close in the right order.
  // Nesting is real: a fragment resolved through the catalog can be
  // interpolated into another catalog string.
  const openSpans: boolean[] = [];

  while (i < html.length) {
    const ch = html[i];

    if (!inTag && ch === "<") {
      inTag = true;
      out += ch;
      i += 1;
      continue;
    }
    if (inTag && ch === ">") {
      inTag = false;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === SENTINEL_START) {
      const sep = html.indexOf(SENTINEL_SEP, i);
      if (sep === -1) {
        i += 1; // malformed: drop it rather than emit a control character
        continue;
      }
      const key = html.slice(i + 1, sep);
      // Only wrap in text position. A catalog string interpolated into an
      // ATTRIBUTE must stay a bare value; a <span> there is broken HTML.
      if (inTag) {
        openSpans.push(false);
      } else {
        out += `<span data-fc-key="${escapeAttr(key)}">`;
        openSpans.push(true);
      }
      i = sep + 1;
      continue;
    }

    if (ch === SENTINEL_END) {
      if (openSpans.pop()) out += "</span>";
      i += 1;
      continue;
    }

    if (ch === SENTINEL_SEP) {
      i += 1; // stray separator: drop
      continue;
    }

    out += ch;
    i += 1;
  }
  // Unbalanced input shouldn't leave the document with dangling open tags.
  while (openSpans.length) if (openSpans.pop()) out += "</span>";
  return out;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Every catalog key that actually rendered, in document order, de-duplicated.
 * The editor uses this to list the fields for a message — derived from what was
 * really produced rather than from a hand-maintained list that would drift. */
export function keysInOrder(rendered: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let i = 0;
  while (i < rendered.length) {
    const start = rendered.indexOf(SENTINEL_START, i);
    if (start === -1) break;
    const sep = rendered.indexOf(SENTINEL_SEP, start);
    if (sep === -1) break;
    const key = rendered.slice(start + 1, sep);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
    i = sep + 1;
  }
  return out;
}
