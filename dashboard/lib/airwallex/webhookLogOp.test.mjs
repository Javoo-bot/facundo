import test from "node:test";
import assert from "node:assert/strict";
import { webhookLogOp } from "./webhookLogOp.ts";

const COMMON = { provider: "airwallex", operation: "webhook_in", direction: "in" };

// Every verifyWebhook reject reason must still produce a real record — this is
// the whole point: a rejected delivery used to leave zero trace anywhere.
for (const reason of ["no-secret-configured", "missing-headers", "bad-timestamp", "stale-timestamp", "bad-signature"]) {
  test(`reject reason "${reason}" -> ok:false, 401, error carries the reason`, () => {
    const op = webhookLogOp({ ok: false, statusCode: 401, error: reason });
    assert.deepEqual(op, { ...COMMON, ok: false, statusCode: 401, error: reason, ref: null, meta: null });
  });
}

test("bad-json (verified but unparseable body) -> ok:false, 400", () => {
  const op = webhookLogOp({ ok: false, statusCode: 400, error: "bad-json" });
  assert.deepEqual(op, { ...COMMON, ok: false, statusCode: 400, error: "bad-json", ref: null, meta: null });
});

test("success -> ok:true, 200, event name + id carried, no error", () => {
  const op = webhookLogOp({ ok: true, statusCode: 200, eventName: "issuing.transaction.succeeded", eventId: "evt_123" });
  assert.deepEqual(op, {
    ...COMMON,
    ok: true,
    statusCode: 200,
    error: null,
    ref: "evt_123",
    meta: { event: "issuing.transaction.succeeded" },
  });
});

test("success with no event name/id (defensive — malformed but signed body) -> still logs cleanly", () => {
  const op = webhookLogOp({ ok: true, statusCode: 200 });
  assert.deepEqual(op, { ...COMMON, ok: true, statusCode: 200, error: null, ref: null, meta: null });
});

test("never carries a body/signature field — only the declared shape", () => {
  const op = webhookLogOp({ ok: false, statusCode: 401, error: "bad-signature" });
  assert.deepEqual(Object.keys(op).sort(), ["direction", "error", "meta", "ok", "operation", "provider", "ref", "statusCode"]);
});
