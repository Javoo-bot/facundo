// SMS segment math. ZERO IMPORTS BY DESIGN — this is used both server-side
// (lib/sms.ts callers) and inside a CLIENT component (the live segment counter
// in components/OutreachSendPanel.tsx). Its sibling lib/offerSmsContent.ts
// imports lib/emailLinks.ts, which reads the server-only APP_BASE_URL env var
// and therefore must never be pulled across the client boundary. Keep this
// file dependency-free so either side can import it.

// GSM 03.38 basic character set + the extension table. Characters outside this
// set force the whole message to UCS-2, which more than halves the per-segment
// budget (70 instead of 160). Note what is NOT here: á í ó ú — so Spanish and
// Italian copy is far easier to push into UCS-2 than it looks.
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// Each of these occupies TWO GSM-7 septets.
const GSM7_EXTENDED = "^{}\\[~]|€";

/** True when every character is encodable in GSM-7 (so the message gets
 * 160-char segments rather than UCS-2's 70). */
export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.includes(ch) && !GSM7_EXTENDED.includes(ch)) return false;
  }
  return true;
}

// Unicode combining diacritical marks (U+0300–U+036F) — what NFD decomposition
// splits an accented character into (e.g. "á" -> "a" + U+0301). Stripping
// these after decomposition is how we fold á/í/ó/ú/etc. down to GSM-7-safe
// ASCII without touching characters that are already GSM-7 (à é ù ì ò ñ ü ä ö
// are handled by the isGsm7 check below and never reach this fallback).
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Best-effort fold of `text` into a GSM-7-safe form, character by character.
 * Already-GSM-7 characters (including à é ù ì ò ñ ü ä ö) are left untouched.
 * A non-GSM-7 character is folded via NFD decomposition + combining-mark
 * strip (á -> a, Ó -> O, ç -> c); if that fold is itself still not GSM-7
 * (e.g. Cyrillic, Greek, CJK), the original character is kept as-is rather
 * than mangled or replaced — an honest higher segment count beats an
 * unreadable name. */
export function toGsm7Safe(text: string): string {
  let result = "";
  for (const ch of text) {
    if (isGsm7(ch)) {
      result += ch;
      continue;
    }
    const folded = ch.normalize("NFD").replace(COMBINING_MARKS, "");
    result += isGsm7(folded) ? folded : ch;
  }
  return result;
}

/** Billable segment count. GSM-7: 160 for a single segment, 153 each when
 * concatenated (7 septets go to the multipart header). UCS-2: 70 and 67.
 * Extension-table characters count double in GSM-7. */
export function smsSegments(text: string): number {
  if (isGsm7(text)) {
    let septets = 0;
    for (const ch of text) septets += GSM7_EXTENDED.includes(ch) ? 2 : 1;
    if (septets <= 160) return 1;
    return Math.ceil(septets / 153);
  }
  // UCS-2 is counted in UTF-16 code units, not code points — an emoji or any
  // astral character costs two.
  const units = text.length;
  if (units <= 70) return 1;
  return Math.ceil(units / 67);
}
