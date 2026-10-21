// Airwallex webhook signature verification.
//
// Airwallex sends `x-timestamp` (ms) and `x-signature` = HMAC-SHA256 hex of
// (timestamp + raw request body), keyed by the endpoint's secret. We MUST
// verify against the UNMODIFIED raw body before parsing, use a timing-safe
// compare, and reject stale timestamps to bound replay.

import crypto from "node:crypto";

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyOpts {
  toleranceMs?: number; // max clock skew / replay window (default 5 min)
  nowMs?: number; // injectable for tests
}

export function verifyWebhook(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string | undefined,
  opts: VerifyOpts = {},
): VerifyResult {
  if (!secret) return { ok: false, reason: "no-secret-configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing-headers" };

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "bad-timestamp" };

  const tolerance = opts.toleranceMs ?? 5 * 60_000;
  const now = opts.nowMs ?? Date.now();
  if (Math.abs(now - tsNum) > tolerance) return { ok: false, reason: "stale-timestamp" };

  const expected = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // Length check first — timingSafeEqual throws on unequal lengths, and the
  // length of a hex digest isn't secret-dependent, so this doesn't leak.
  if (a.length !== b.length) return { ok: false, reason: "bad-signature" };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}
