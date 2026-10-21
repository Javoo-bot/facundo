// Readable plain text from an inbound email's HTML.
//
// WHY: some mail clients send a reply as HTML only, with an empty text part.
// The inbound webhook read only the text part, so on 2026-09-16, the first
// afternoon real florist replies reached the app, a reply from
// info@florneu-demo.com arrived as 10,396 characters of HTML and 0 of text. The
// thread, the assistant and /communications all saw a blank message. This is
// the fallback used when the text part is empty.
//
// Deliberately simple, not a sanitizer: the result is stored as plain text and
// shown as text, never rendered as HTML, so the job is only to keep the words
// and their line breaks. The raw HTML is still stored alongside it.
//
// Alias-free (no imports) so plain `node --test` can reach it.

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  laquo: "«", raquo: "»", euro: "€", hellip: "…", ndash: "–", mdash: "—",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const text = html
    // Content that is never words a person wrote.
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Structure that means a line break.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    // Everything else.
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
