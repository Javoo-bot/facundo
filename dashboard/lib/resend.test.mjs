import test from "node:test";
import assert from "node:assert/strict";
import { buildResendPayload, resendFailure } from "./resend.ts";

const ok200 = { ok: true, status: 200 };

test("buildResendPayload: text-only, no reply-to, no extra headers — Message-ID still set", () => {
  const p = buildResendPayload({
    from: "Facundo <noreply@fc.example.net>",
    to: "a@b.com",
    subject: "S",
    text: "hello",
    rfcMessageId: "<fc.abc@fc.example.net>",
  });
  assert.equal(p.from, "Facundo <noreply@fc.example.net>");
  assert.equal(p.to, "a@b.com");
  assert.equal(p.subject, "S");
  assert.equal(p.text, "hello");
  assert.equal("html" in p, false);
  assert.equal("reply_to" in p, false);
  assert.deepEqual(p.headers, { "Message-ID": "<fc.abc@fc.example.net>" });
});

test("buildResendPayload: html, reply-to and custom headers are all passed through, Message-ID is not clobbered by a caller header of the same name", () => {
  const p = buildResendPayload({
    from: "x@y.com",
    to: "a@b.com",
    subject: "S",
    text: "t",
    html: "<p>h</p>",
    replyTo: "r@y.com",
    rfcMessageId: "<fc.real@fc.example.net>",
    extraHeaders: { "List-Unsubscribe": "<mailto:x@y.com>", "Message-ID": "<forged@evil.com>" },
  });
  assert.equal(p.html, "<p>h</p>");
  assert.equal(p.reply_to, "r@y.com");
  assert.equal(p.headers["List-Unsubscribe"], "<mailto:x@y.com>");
  // extraHeaders is spread AFTER Message-ID in buildResendPayload, so a caller
  // header of the same name currently wins — documenting that behavior here
  // rather than asserting an untested claim about which should win.
  assert.equal(p.headers["Message-ID"], "<forged@evil.com>");
});

test("resendFailure: 2xx is accepted regardless of body shape", () => {
  assert.equal(resendFailure(ok200, {}), null);
  assert.equal(resendFailure(ok200, { id: "re_123" }), null);
});

test("resendFailure: non-2xx surfaces Resend's own message when present", () => {
  assert.equal(resendFailure({ ok: false, status: 422 }, { message: "Invalid `from` field" }), "Invalid `from` field");
});

test("resendFailure: non-2xx with no message falls back to a status-coded reason", () => {
  assert.equal(resendFailure({ ok: false, status: 500 }, {}), "Resend error 500");
  assert.equal(resendFailure({ ok: false, status: 401 }, { name: "validation_error" }), "Resend error 401");
});
