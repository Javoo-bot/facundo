import { createHmac, timingSafeEqual } from "node:crypto";

// Pure signing/verification for the "view as florist" cookie. Kept free of
// `server-only`, next/headers, and DB deps so it can be unit-tested directly
// (lib/viewAsToken.test.mjs). Session re-verification + cookie I/O live in
// lib/viewAs.ts, which wraps these with the app's actual signing secret.

export type ViewAsClaim = { floristId: string; staffEmail: string; exp: number };

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Encode + HMAC-sign a claim into a `body.sig` token. */
export function encodeClaim(claim: ViewAsClaim, secret: string): string {
  const body = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify signature + shape and return the claim, or null if the token is
 * malformed or tampered. Expiry is NOT checked here — the caller compares
 * `claim.exp` against the current time (kept out so this stays time-pure/testable).
 */
export function decodeClaim(token: string, secret: string): ViewAsClaim | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Constant-time compare; timingSafeEqual throws on length mismatch, so guard.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ViewAsClaim;
    if (
      !claim ||
      typeof claim.floristId !== "string" ||
      typeof claim.staffEmail !== "string" ||
      typeof claim.exp !== "number"
    ) {
      return null;
    }
    return claim;
  } catch {
    return null;
  }
}
