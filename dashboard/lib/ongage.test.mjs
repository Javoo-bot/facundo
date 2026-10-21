import test from "node:test";
import assert from "node:assert/strict";
import { buildOngagePayload, ongageFailure, ongageConfig } from "./ongage.ts";
import { parseFrom, defaultFrom, defaultFromAddress, DEFAULT_FROM } from "./emailFrom.ts";

const ok200 = { ok: true, status: 200 };

test("ongageFailure: success=1 is accepted", () => {
  const data = { metadata: { error: false }, payload: { total: 1, success: 1, failed: 0, suppressed: 0, not_active: 0, queued: 0, failed_emails: [] } };
  assert.equal(ongageFailure(ok200, data, "a@b.com"), null);
});

test("ongageFailure: queued counts as accepted", () => {
  assert.equal(ongageFailure(ok200, { payload: { success: 0, queued: 1 } }, "a@b.com"), null);
});

test("ongageFailure: HTTP 200 with success=0 is a failure, with the per-recipient reason", () => {
  const data = { metadata: { error: false }, payload: { total: 1, success: 0, failed: 1, failed_emails: { "a@b.com": "Excluded" } } };
  assert.equal(ongageFailure(ok200, data, "a@b.com"), "Ongage rejected recipient: Excluded");
  assert.equal(ongageFailure(ok200, { payload: { success: 0, suppressed: 1, failed_emails: [] } }, "a@b.com"), "Ongage: recipient is on a suppression list");
  assert.equal(ongageFailure(ok200, { payload: { success: 0, not_active: 1 } }, "a@b.com"), "Ongage: recipient is not active (unsubscribed/bounced)");
  assert.match(ongageFailure(ok200, { payload: { success: 0 } }, "a@b.com"), /delivered to nobody/);
});

test("ongageFailure: non-2xx / metadata.error surface Ongage's message or the status", () => {
  assert.equal(ongageFailure({ ok: false, status: 403 }, { metadata: { error: true, message: "Permission error" } }, "a@b.com"), "Permission error");
  assert.equal(ongageFailure({ ok: false, status: 500 }, {}, "a@b.com"), "Ongage error 500");
  assert.equal(ongageFailure({ ok: false, status: 400 }, { payload: "bad list" }, "a@b.com"), "bad list");
  assert.equal(ongageFailure(ok200, {}, "a@b.com"), "Ongage returned no payload");
});

test("buildOngagePayload: html kept, text fallback wrapped+escaped, reply-to defaults to from", () => {
  const p = buildOngagePayload({ to: "a@b.com", subject: "S", text: "1 < 2 & 3", fromName: "Facundo", fromAddress: "noreply@fc.example.com", connectionId: 7 });
  assert.deepEqual(p.recipients, ["a@b.com"]);
  assert.equal(p.sending_connection_id, 7);
  assert.equal(p.disable_unsubscribe, true);
  assert.equal(p.message.content_text, "1 < 2 & 3");
  assert.match(p.message.content_html, /1 &lt; 2 &amp; 3/);
  assert.equal(p.message.addresses.reply_address, "noreply@fc.example.com");
  const q = buildOngagePayload({ to: "a@b.com", subject: "S", text: "t", html: "<p>h</p>", fromName: "", fromAddress: "x@y.com", replyTo: "r@y.com", connectionId: 7 });
  assert.equal(q.message.content_html, "<p>h</p>");
  assert.equal(q.message.addresses.from_name, "Facundo");
  assert.equal(q.message.addresses.reply_address, "r@y.com");
});

test("ongageConfig: fails closed unless every variable is set", () => {
  const keys = ["ONGAGE_LIST_ID", "ONGAGE_USERNAME", "ONGAGE_PASSWORD", "ONGAGE_ACCOUNT_CODE", "ONGAGE_SENDING_CONNECTION_ID"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(ongageConfig(), null);
    process.env.ONGAGE_LIST_ID = " 1 "; process.env.ONGAGE_USERNAME = "u"; process.env.ONGAGE_PASSWORD = "p"; process.env.ONGAGE_ACCOUNT_CODE = "c";
    assert.equal(ongageConfig(), null);
    process.env.ONGAGE_SENDING_CONNECTION_ID = "abc";
    assert.equal(ongageConfig(), null);
    process.env.ONGAGE_SENDING_CONNECTION_ID = "42";
    assert.deepEqual(ongageConfig(), { listId: "1", username: "u", password: "p", accountCode: "c", connectionId: 42 });
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("parseFrom / defaultFrom", () => {
  assert.deepEqual(parseFrom("Facundo <noreply@fc.example.com>"), { name: "Facundo", address: "noreply@fc.example.com" });
  assert.deepEqual(parseFrom('"Marta Ruiz" <noreply@fc.example.com>'), { name: "Marta Ruiz", address: "noreply@fc.example.com" });
  assert.deepEqual(parseFrom("noreply@fc.example.com"), { name: "", address: "noreply@fc.example.com" });
  const saved = process.env.ONGAGE_FROM;
  try {
    delete process.env.ONGAGE_FROM;
    assert.equal(defaultFrom(), DEFAULT_FROM);
    assert.equal(defaultFromAddress(), "noreply@fc.example.com");
    process.env.ONGAGE_FROM = "FC Ops <orders@fc.example.com>";
    assert.equal(defaultFromAddress(), "orders@fc.example.com");
  } finally {
    if (saved === undefined) delete process.env.ONGAGE_FROM; else process.env.ONGAGE_FROM = saved;
  }
});
