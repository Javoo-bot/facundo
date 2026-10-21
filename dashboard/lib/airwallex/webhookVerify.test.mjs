import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyWebhook } from "./webhookVerify.ts";

const SECRET = "whsec_test";
const body = JSON.stringify({ id: "evt_1", name: "issuing.transaction.succeeded" });

function sign(ts, rawBody, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(ts + rawBody).digest("hex");
}

test("valid signature within tolerance -> ok", () => {
  const ts = "1000000";
  const sig = sign(ts, body);
  assert.deepEqual(verifyWebhook(body, ts, sig, SECRET, { nowMs: 1_000_000 }), { ok: true });
});

test("tampered body -> bad-signature", () => {
  const ts = "1000000";
  const sig = sign(ts, body);
  const r = verifyWebhook(body + "x", ts, sig, SECRET, { nowMs: 1_000_000 });
  assert.deepEqual(r, { ok: false, reason: "bad-signature" });
});

test("wrong secret -> bad-signature", () => {
  const ts = "1000000";
  const sig = sign(ts, body, "wrong");
  assert.equal(verifyWebhook(body, ts, sig, SECRET, { nowMs: 1_000_000 }).ok, false);
});

test("stale timestamp -> stale-timestamp", () => {
  const ts = "1000000";
  const sig = sign(ts, body);
  // now is 10 minutes later, tolerance default 5 min
  const r = verifyWebhook(body, ts, sig, SECRET, { nowMs: 1_000_000 + 10 * 60_000 });
  assert.deepEqual(r, { ok: false, reason: "stale-timestamp" });
});

test("future timestamp beyond tolerance -> stale-timestamp", () => {
  const ts = String(1_000_000 + 10 * 60_000);
  const sig = sign(ts, body);
  assert.equal(verifyWebhook(body, ts, sig, SECRET, { nowMs: 1_000_000 }).reason, "stale-timestamp");
});

test("missing headers / secret / bad ts", () => {
  const ts = "1000000";
  const sig = sign(ts, body);
  assert.equal(verifyWebhook(body, null, sig, SECRET, { nowMs: 1_000_000 }).reason, "missing-headers");
  assert.equal(verifyWebhook(body, ts, null, SECRET, { nowMs: 1_000_000 }).reason, "missing-headers");
  assert.equal(verifyWebhook(body, ts, sig, undefined, { nowMs: 1_000_000 }).reason, "no-secret-configured");
  assert.equal(verifyWebhook(body, "not-a-number", sig, SECRET, { nowMs: 1_000_000 }).reason, "bad-timestamp");
});

test("signature of different length -> bad-signature (no throw)", () => {
  const ts = "1000000";
  assert.deepEqual(verifyWebhook(body, ts, "abc", SECRET, { nowMs: 1_000_000 }), { ok: false, reason: "bad-signature" });
});
