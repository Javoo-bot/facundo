import { createHmac, timingSafeEqual } from "node:crypto";

// Customer-safe, time-limited access to a delivery-proof photo. The buyer has no
// login, so the "delivered" email links to the proof via a signed, expiring URL:
// an HMAC over (key, expiry) that the public proof route re-derives and checks.
// No secret configured → no token → the email falls back to plain text (the photo
// is simply omitted), so this is a no-op until PROOF_SECRET/OUTBOX_SECRET is set.

function secret(): string | null {
  return process.env.PROOF_SECRET || process.env.OUTBOX_SECRET || null;
}

function sign(key: string, exp: number, s: string): string {
  return createHmac("sha256", s).update(`${key}.${exp}`).digest("base64url");
}

// Returns a `{key, exp, sig}` query string (no leading '?'), or null if unconfigured.
export function signProofToken(key: string, exp: number): string | null {
  const s = secret();
  if (!s) return null;
  const sig = sign(key, exp, s);
  return `key=${encodeURIComponent(key)}&exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

// Build the absolute proof URL for the delivered email, or null if unconfigured.
export function buildProofUrl(base: string | undefined, key: string, ttlSeconds = 30 * 24 * 3600): string | null {
  if (!base) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const qs = signProofToken(key, exp);
  return qs ? `${base.replace(/\/+$/, "")}/api/orders/proof?${qs}` : null;
}

export function verifyProofToken(key: string, exp: number, sig: string): boolean {
  const s = secret();
  if (!s) return false;
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false; // expired or malformed
  const expected = sign(key, exp, s);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
