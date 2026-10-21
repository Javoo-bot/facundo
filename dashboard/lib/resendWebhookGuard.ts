import crypto from "node:crypto";

/** How far `svix-timestamp` may sit from our clock, in either direction.
 * Svix's own reference implementations use 5 minutes; the tolerance is
 * symmetric because the sender's clock can be ahead as easily as behind. */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** True when `svix-timestamp` (unix seconds, as a string) is within
 * TIMESTAMP_TOLERANCE_SECONDS of `nowMs`.
 *
 * Without this the timestamp was only ever HMAC *input* — it was signed, so it
 * couldn't be tampered with, but nothing ever compared it to the clock. A
 * request captured off the wire therefore stayed valid forever and could be
 * replayed at will to inflate the email funnel on /statistics. Signature
 * verification proves "Resend sent this"; the window is what proves "recently".
 *
 * Split out and exported so it is directly testable without constructing a
 * valid HMAC. */
export function isTimestampFresh(timestamp: string, nowMs: number): boolean {
  // Number("") is 0 and Number(" 12 ") is 12, neither of which should pass as a
  // timestamp — require a bare integer.
  if (!/^-?\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(nowMs / 1000 - seconds) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/** Verifies a Resend webhook's Svix signature *and* that it is recent.
 * `secret` is the whsec_-prefixed signing secret from Resend's webhook settings
 * (RESEND_WEBHOOK_SECRET). Pure function — no network, no DB — so the route
 * around it stays thin. `nowMs` is injectable for tests. */
export function verifyResendSignature(
  payload: string,
  headers: { "svix-id": string; "svix-timestamp": string; "svix-signature": string },
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  const { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signatureHeader } = headers;
  if (!id || !timestamp || !signatureHeader) return false;
  if (!isTimestampFresh(timestamp, nowMs)) return false;

  const secretBytes = Buffer.from(secret.split("_")[1] ?? "", "base64");
  if (!secretBytes.length) return false;

  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");

  return signatureHeader.split(" ").some((candidate) => {
    const [version, sig] = candidate.split(",");
    if (version !== "v1" || !sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}
