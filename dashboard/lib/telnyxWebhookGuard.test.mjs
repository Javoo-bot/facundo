// Sanity assertions for Telnyx webhook authentication. Run with:
//   node --test lib/telnyxWebhookGuard.test.mjs
//
// Mirrors lib/resendWebhookGuard.test.mjs. The signature scheme differs
// (Ed25519 over `${timestamp}|${body}`, not HMAC over `${id}.${ts}.${body}`),
// so the fixtures are generated here with a throwaway keypair rather than
// hard-coded.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyTelnyxSignature,
  isTimestampFresh,
  isPermanentSmsFailure,
  isSmsEventType,
  TIMESTAMP_TOLERANCE_SECONDS,
} from "./telnyxWebhookGuard.ts";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
// Telnyx hands out the BARE 32-byte key, base64'd — strip node's SPKI header
// so the fixture matches what actually arrives in the env var.
const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(12);
const PUBLIC_B64 = rawPublic.toString("base64");

const NOW = 1_786_000_000_000;
const TS = Math.floor(NOW / 1000).toString();

function sign(payload, timestamp = TS, key = privateKey) {
  return crypto.sign(null, Buffer.from(`${timestamp}|${payload}`, "utf8"), key).toString("base64");
}
function headers(payload, { timestamp = TS, signature } = {}) {
  return {
    "telnyx-signature-ed25519": signature ?? sign(payload, timestamp),
    "telnyx-timestamp": timestamp,
  };
}

const BODY = JSON.stringify({ data: { event_type: "message.finalized", id: "evt_1" } });

test("accepts a correctly signed, recent webhook", () => {
  assert.equal(verifyTelnyxSignature(BODY, headers(BODY), PUBLIC_B64, NOW), true);
});

test("rejects a payload that was tampered with after signing", () => {
  const h = headers(BODY);
  const tampered = JSON.stringify({ data: { event_type: "message.finalized", id: "evt_EVIL" } });
  assert.equal(verifyTelnyxSignature(tampered, h, PUBLIC_B64, NOW), false);
});

test("rejects a signature from a different key", () => {
  const other = crypto.generateKeyPairSync("ed25519").privateKey;
  assert.equal(
    verifyTelnyxSignature(BODY, headers(BODY, { signature: sign(BODY, TS, other) }), PUBLIC_B64, NOW),
    false,
  );
});

test("rejects a replay outside the freshness window even though the signature is valid", () => {
  // The whole point of the window: a captured request must not stay valid
  // forever. Replaying a delivery_failed would silence a florist's number.
  const old = (Math.floor(NOW / 1000) - TIMESTAMP_TOLERANCE_SECONDS - 1).toString();
  const h = headers(BODY, { timestamp: old });
  assert.equal(verifyTelnyxSignature(BODY, h, PUBLIC_B64, NOW), false);
  // ...and the same request one second inside the window is fine, proving the
  // rejection is the clock and not a broken signature.
  const fresh = (Math.floor(NOW / 1000) - TIMESTAMP_TOLERANCE_SECONDS + 1).toString();
  assert.equal(verifyTelnyxSignature(BODY, headers(BODY, { timestamp: fresh }), PUBLIC_B64, NOW), true);
});

test("rejects a future timestamp beyond tolerance — the sender's clock can be ahead too", () => {
  const ahead = (Math.floor(NOW / 1000) + TIMESTAMP_TOLERANCE_SECONDS + 1).toString();
  assert.equal(verifyTelnyxSignature(BODY, headers(BODY, { timestamp: ahead }), PUBLIC_B64, NOW), false);
});

test("rejects missing headers and an unset public key rather than throwing", () => {
  assert.equal(verifyTelnyxSignature(BODY, { "telnyx-signature-ed25519": "", "telnyx-timestamp": TS }, PUBLIC_B64, NOW), false);
  assert.equal(verifyTelnyxSignature(BODY, { "telnyx-signature-ed25519": sign(BODY), "telnyx-timestamp": "" }, PUBLIC_B64, NOW), false);
  // An unset TELNYX_PUBLIC_KEY must fail closed, not accept everything.
  assert.equal(verifyTelnyxSignature(BODY, headers(BODY), "", NOW), false);
});

test("rejects malformed keys and signatures rather than throwing", () => {
  assert.equal(verifyTelnyxSignature(BODY, headers(BODY), "not-base64!!", NOW), false);
  assert.equal(verifyTelnyxSignature(BODY, headers(BODY), Buffer.alloc(31).toString("base64"), NOW), false);
  assert.equal(
    verifyTelnyxSignature(BODY, { ...headers(BODY), "telnyx-signature-ed25519": "AAAA" }, PUBLIC_B64, NOW),
    false,
  );
});

test("isTimestampFresh requires a bare integer", () => {
  const now = 1_700_000_000_000;
  assert.equal(isTimestampFresh("1700000000", now), true);
  assert.equal(isTimestampFresh(" 1700000000 ", now), false);
  assert.equal(isTimestampFresh("", now), false);
  assert.equal(isTimestampFresh("abc", now), false);
});

// --- the rule that silences a channel ---------------------------------------

test("only Telnyx's documented permanent codes silence a number", () => {
  assert.equal(isPermanentSmsFailure(["40300"]), true);
  assert.equal(isPermanentSmsFailure(["40010"]), true);
  // Temporary and intervention-required must NOT silence: the cost of getting
  // this wrong is a florist who stops hearing about orders entirely.
  assert.equal(isPermanentSmsFailure(["40006"]), false);
  assert.equal(isPermanentSmsFailure(["40008"]), false);
  assert.equal(isPermanentSmsFailure(["40002"]), false);
  assert.equal(isPermanentSmsFailure(["40016"]), false);
});

test("an unrecognised or absent code keeps the channel open", () => {
  assert.equal(isPermanentSmsFailure(["49999"]), false);
  assert.equal(isPermanentSmsFailure([]), false);
});

test("a permanent code among several still counts", () => {
  assert.equal(isPermanentSmsFailure(["40006", "40300"]), true);
});

test("isSmsEventType gates what can reach the DB check constraint", () => {
  assert.equal(isSmsEventType("delivered"), true);
  assert.equal(isSmsEventType("delivery_failed"), true);
  assert.equal(isSmsEventType("opened"), false); // an SMS is never 'opened'
  assert.equal(isSmsEventType(""), false);
});
