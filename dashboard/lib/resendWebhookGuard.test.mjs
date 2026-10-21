import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyResendSignature, isTimestampFresh, TIMESTAMP_TOLERANCE_SECONDS } from "./resendWebhookGuard.ts";

const SECRET = "whsec_dGVzdHNlY3JldA=="; // "testsecret" base64, Svix's documented format
const TS = "1700000000";
const NOW = Number(TS) * 1000; // pinned "current time" so signed fixtures stay fresh forever

function sign(id, timestamp, payload, secret) {
  const secretBytes = Buffer.from(secret.split("_")[1], "base64");
  const signedContent = `${id}.${timestamp}.${payload}`;
  const sig = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  return `v1,${sig}`;
}

test("accepts a correctly signed payload", () => {
  const payload = JSON.stringify({ type: "email.delivered" });
  const id = "msg_1";
  const signature = sign(id, TS, payload, SECRET);
  const ok = verifyResendSignature(payload, { "svix-id": id, "svix-timestamp": TS, "svix-signature": signature }, SECRET, NOW);
  assert.equal(ok, true);
});

test("rejects a tampered payload", () => {
  const payload = JSON.stringify({ type: "email.delivered" });
  const id = "msg_1";
  const signature = sign(id, TS, payload, SECRET);
  const ok = verifyResendSignature(payload + "x", { "svix-id": id, "svix-timestamp": TS, "svix-signature": signature }, SECRET, NOW);
  assert.equal(ok, false);
});

test("rejects a missing signature header", () => {
  const ok = verifyResendSignature("{}", { "svix-id": "x", "svix-timestamp": TS, "svix-signature": "" }, SECRET, NOW);
  assert.equal(ok, false);
});

// ---- replay window ---------------------------------------------------------
// The regression: svix-timestamp was HMAC input only and never compared to the
// clock, so a captured signed request stayed valid indefinitely.

test("rejects a genuinely-signed request replayed after the tolerance window", () => {
  const payload = JSON.stringify({ type: "email.delivered" });
  const id = "msg_replay";
  const signature = sign(id, TS, payload, SECRET);
  const headers = { "svix-id": id, "svix-timestamp": TS, "svix-signature": signature };

  // Same bytes, same valid signature — only the clock has moved on.
  assert.equal(verifyResendSignature(payload, headers, SECRET, NOW), true, "fresh");
  const wayLater = NOW + (TIMESTAMP_TOLERANCE_SECONDS + 60) * 1000;
  assert.equal(verifyResendSignature(payload, headers, SECRET, wayLater), false, "replayed an hour later");
});

test("isTimestampFresh accepts both edges of the window and rejects just past them", () => {
  const t = 1700000000;
  const at = (offsetSeconds) => isTimestampFresh(String(t), (t + offsetSeconds) * 1000);
  assert.equal(at(0), true);
  assert.equal(at(TIMESTAMP_TOLERANCE_SECONDS), true, "exactly at the trailing edge");
  assert.equal(at(-TIMESTAMP_TOLERANCE_SECONDS), true, "exactly at the leading edge (sender clock ahead)");
  assert.equal(at(TIMESTAMP_TOLERANCE_SECONDS + 1), false, "one second stale");
  assert.equal(at(-(TIMESTAMP_TOLERANCE_SECONDS + 1)), false, "one second in the future");
});

test("isTimestampFresh rejects non-integer timestamps rather than coercing them", () => {
  // Number("") === 0 and Number(" 1700000000 ") === 1700000000, so a bare
  // Number() would let both of these through.
  assert.equal(isTimestampFresh("", 0), false, "empty string must not coerce to 0");
  assert.equal(isTimestampFresh(" 1700000000 ", 1700000000_000), false, "padded");
  assert.equal(isTimestampFresh("1700000000.5", 1700000000_000), false, "fractional");
  assert.equal(isTimestampFresh("not-a-number", 1700000000_000), false);
  assert.equal(isTimestampFresh("1700000000", 1700000000_000), true, "the well-formed control");
});
