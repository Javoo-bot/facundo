import test from "node:test";
import assert from "node:assert/strict";
import {
  isMachineClick,
  isScannerUserAgent,
  clickSignalsFromResend,
  MIN_HUMAN_DWELL_MS,
} from "./clickQuality.ts";

const T = Date.parse("2026-08-08T09:00:00.000Z");
const iso = (offsetMs) => new Date(T + offsetMs).toISOString();

test("known corporate link scanners are recognised", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1) SafeLinks",
    "Proofpoint-URLDefense/1.0",
    "Mimecast-Link-Protect",
    "BarracudaCentral/1.1",
    "Cisco IronPort URL Scanner",
    "Mozilla/5.0 HeadlessChrome/120.0",
    "python-requests/2.31.0",
    "curl/8.4.0",
    "Go-http-client/1.1",
    "Googlebot-Image/1.0",
  ]) {
    assert.ok(isScannerUserAgent(ua), `missed a scanner: ${ua}`);
  }
});

test("real browsers are not mistaken for scanners", () => {
  for (const ua of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
  ]) {
    assert.ok(!isScannerUserAgent(ua), `false positive on a real browser: ${ua}`);
  }
});

// A scanner fires essentially at delivery; a human has to be notified, unlock a
// phone, read enough to care, and tap.
test("a click within a few seconds of delivery is a machine", () => {
  assert.equal(isMachineClick({ deliveredAt: iso(0), clickedAt: iso(500) }), true);
  assert.equal(isMachineClick({ deliveredAt: iso(0), clickedAt: iso(MIN_HUMAN_DWELL_MS - 1) }), true);
});

test("a click after the dwell window is a human", () => {
  assert.equal(isMachineClick({ deliveredAt: iso(0), clickedAt: iso(MIN_HUMAN_DWELL_MS) }), false);
  assert.equal(isMachineClick({ deliveredAt: iso(0), clickedAt: iso(60_000) }), false);
  assert.equal(isMachineClick({ deliveredAt: iso(0), clickedAt: iso(6 * 3600_000) }), false);
});

// The asymmetry that sets the default: a missed scanner costs two cold touches
// for one prospect; a discarded real click costs the prospect entirely, because
// they showed interest and we then went quiet. So only positive evidence counts.
test("with no evidence either way, the click is treated as human", () => {
  assert.equal(isMachineClick({}), false);
  assert.equal(isMachineClick({ userAgent: null, clickedAt: null, deliveredAt: null }), false);
  assert.equal(isMachineClick({ clickedAt: iso(1000) }), false, "no delivery time → no timing evidence");
  assert.equal(isMachineClick({ deliveredAt: iso(0) }), false, "no click time → no timing evidence");
  assert.equal(isMachineClick({ userAgent: "", clickedAt: "nonsense", deliveredAt: "also nonsense" }), false);
});

// Provider event timestamps are not perfectly ordered; a negative dwell is clock
// skew, not evidence of anything.
test("a click timestamped before delivery is clock skew, not a machine", () => {
  assert.equal(isMachineClick({ deliveredAt: iso(0), clickedAt: iso(-2000) }), false);
});

test("a scanner user agent wins even with a long dwell", () => {
  assert.equal(
    isMachineClick({ userAgent: "Proofpoint-URLDefense/1.0", deliveredAt: iso(0), clickedAt: iso(3600_000) }),
    true
  );
});

// ---- payload extraction ----

test("click signals are read out of the Resend payload", () => {
  const s = clickSignalsFromResend({
    type: "email.clicked",
    data: { click: { userAgent: "SafeLinks", timestamp: "2026-08-08T09:00:01.000Z" } },
  });
  assert.equal(s.userAgent, "SafeLinks");
  assert.equal(s.clickedAt, "2026-08-08T09:00:01.000Z");
});

test("the snake_case variant of the field is read too", () => {
  const s = clickSignalsFromResend({ data: { click: { user_agent: "curl/8.4.0" } } });
  assert.equal(s.userAgent, "curl/8.4.0");
});

test("extraction never throws on an unexpected payload", () => {
  for (const b of [null, undefined, {}, { data: null }, { data: { click: "nope" } }, "string", 42]) {
    const s = clickSignalsFromResend(b);
    assert.equal(typeof s, "object", JSON.stringify(b));
  }
});
