import { randomBytes } from "node:crypto";
import { STAFF_SEGMENTS } from "./hostRouting.ts";

// Short-link codes. Pure + alias-free (no "@/" imports) so plain `node --test`
// can exercise it directly — the same split lib/floristMagicLink.ts and
// lib/floristMagicLinkMint.ts already use. The I/O half lives in
// lib/shortLinkMint.ts.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * 10 base62 chars ≈ 59 bits.
 *
 * Chosen against the SMS segment budget, not arbitrarily. GSM-7 multipart
 * allows 153 chars per segment, so two segments is 306. Root-mounted on
 * bo.fc.example.net a 10-char code yields a 36-char URL, putting the worst
 * locale (fr) at 288 — 18 characters of headroom, which matters because this
 * copy has already been rewritten twice. lib/offerSmsContent.test.mjs pins the
 * budget so a future edit fails the build rather than the invoice.
 */
export const SHORT_CODE_LENGTH = 10;
export const SHORT_CODE_RE = /^[0-9A-Za-z]{10}$/;

export function isShortCode(v: string | null | undefined): boolean {
  return typeof v === "string" && SHORT_CODE_RE.test(v);
}

/**
 * A short code is a CREDENTIAL — it fronts a magic link that signs a florist in
 * — so this uses crypto randomness, never Math.random.
 *
 * Rejection sampling rather than `byte % 62`: 256 is not a multiple of 62, so
 * plain modulo would make the first 8 symbols of the alphabet ~1.5× likelier
 * than the rest, throwing away entropy in exactly the place it matters. 248 is
 * the largest multiple of 62 below 256, so bytes at or above it are discarded.
 */
export function generateShortCode(): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let out = "";
    while (out.length < SHORT_CODE_LENGTH) {
      for (const byte of randomBytes(SHORT_CODE_LENGTH * 2)) {
        if (byte >= 248) continue;
        out += ALPHABET[byte % 62];
        if (out.length === SHORT_CODE_LENGTH) break;
      }
    }
    if (!collidesWithStaffRoute(out)) return out;
  }
  // Unreachable in practice (a staff-segment collision is ~2/62^10 per attempt);
  // throwing beats returning a code that would resolve to a staff page.
  throw new Error("generateShortCode: could not find a non-colliding code");
}

/**
 * Codes are mounted at the SITE ROOT (`bo.fc.example.net/<code>`), so a code
 * that happens to equal a staff route segment would be shadowed by that page —
 * Next resolves static segments before dynamic ones. The staff console is
 * therefore safe, but the link would be permanently dead.
 *
 * `operations` and `statistics` are both exactly 10 base62 characters, so this
 * is a real (if astronomically unlikely) collision, not a hypothetical one.
 * Checked against the live STAFF_SEGMENTS set rather than a copied list, so a
 * staff route added later is covered automatically.
 */
export function collidesWithStaffRoute(code: string): boolean {
  return STAFF_SEGMENTS.has(code);
}

/** `base` is BACKOFFICE_BASE — already trailing-slash-stripped, but be defensive.
 *  Mounted at the ROOT (no path prefix): two saved characters per link is real
 *  headroom against the SMS segment budget, which is the whole point. */
export function buildShortUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, "")}/${code}`;
}
