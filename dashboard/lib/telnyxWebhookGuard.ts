import crypto from "node:crypto";

// Telnyx webhook authentication, split out from the route for the same reason
// lib/resendWebhookGuard.ts is: it's the security boundary, and a pure function
// with no network or DB can be exercised directly by `node --test`.
//
// Telnyx signs with Ed25519 rather than Resend's HMAC:
//   telnyx-signature-ed25519 : base64 signature
//   telnyx-timestamp         : unix seconds
//   signed content           : `${timestamp}|${rawBody}`
// The verifying key is the account's base64 Ed25519 public key
// (GET https://api.telnyx.com/v2/public_key, or the portal).

/** How far `telnyx-timestamp` may sit from our clock, in either direction.
 *
 * Same reasoning, and same value, as the Resend guard: the signature proves
 * "Telnyx sent this", the window proves "recently". Without it a request
 * captured off the wire stays valid forever and can be replayed to inflate the
 * SMS funnel — or, worse here than for email, to replay a delivery_failed and
 * silence a florist's number. */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function isTimestampFresh(timestamp: string, nowMs: number): boolean {
  // Number("") is 0 and Number(" 12 ") is 12; require a bare integer.
  if (!/^-?\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(nowMs / 1000 - seconds) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/** Wrap a raw 32-byte Ed25519 public key in the SPKI DER envelope node's
 *  `createPublicKey` expects. Telnyx hands out the bare key, node won't take
 *  it bare, and the prefix is a fixed 12-byte header for this curve. */
function ed25519KeyFromRaw(raw: Buffer): crypto.KeyObject | null {
  if (raw.length !== 32) return null;
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  try {
    return crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/**
 * Verifies a Telnyx webhook's Ed25519 signature *and* that it is recent.
 *
 * `publicKey` is the base64 Ed25519 public key. `nowMs` is injectable for
 * tests. Returns false — never throws — on every malformed input, so the route
 * around it is a single `if (!ok) return 401`.
 */
export function verifyTelnyxSignature(
  payload: string,
  headers: { "telnyx-signature-ed25519": string; "telnyx-timestamp": string },
  publicKey: string,
  nowMs: number = Date.now(),
): boolean {
  const signature = headers["telnyx-signature-ed25519"];
  const timestamp = headers["telnyx-timestamp"];
  if (!signature || !timestamp || !publicKey) return false;
  if (!isTimestampFresh(timestamp, nowMs)) return false;

  const key = ed25519KeyFromRaw(Buffer.from(publicKey, "base64"));
  if (!key) return false;

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;

  const signedContent = Buffer.from(`${timestamp}|${payload}`, "utf8");
  try {
    // Ed25519 takes no separate digest — the algorithm argument must be null.
    return crypto.verify(null, signedContent, key, signatureBytes);
  } catch {
    return false;
  }
}

/** Telnyx per-recipient delivery statuses, as stored in `sms_events.event_type`. */
export const SMS_EVENT_TYPES = [
  "queued", "sending", "sent", "delivered",
  "sending_failed", "delivery_failed", "delivery_unconfirmed",
] as const;
export type SmsEventType = (typeof SMS_EVENT_TYPES)[number];

export function isSmsEventType(value: string): value is SmsEventType {
  return (SMS_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Telnyx error codes classified as PERMANENT — "do not retry" in their own
 * delivery-error documentation.
 *
 * This set is what stamps `florists.sms_undeliverable_at` and silences a
 * florist's SMS leg, so it is deliberately the documented permanent list and
 * nothing inferred beyond it. Everything else — temporary (40006, 40008),
 * intervention-required (40002, 40011, 40016-40018), and any code Telnyx adds
 * later — is recorded in `sms_events` but never silences anyone.
 *
 * Fails safe in the direction that costs us a wasted text rather than a lost
 * order: an unrecognised code keeps the channel open.
 */
export const PERMANENT_SMS_ERROR_CODES: ReadonlySet<string> = new Set([
  "40001", "40003", "40010", "40300", "40314", "40322",
]);

export function isPermanentSmsFailure(errorCodes: readonly string[]): boolean {
  return errorCodes.some((code) => PERMANENT_SMS_ERROR_CODES.has(code));
}
