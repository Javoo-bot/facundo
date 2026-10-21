import test from "node:test";
import assert from "node:assert/strict";
import { resolveUnsubscribeChannel, buildUnsubscribeUpdate , TEST_MODE_UNSUBSCRIBE_TOKEN, isTestModeUnsubscribeToken } from "./unsubscribeChannel.ts";

// ---- resolveUnsubscribeChannel ----

test("resolveUnsubscribeChannel defaults a missing (undefined) channel to 'email' — backward compat for links minted before SMS existed", () => {
  assert.equal(resolveUnsubscribeChannel(undefined), "email");
});

test("resolveUnsubscribeChannel accepts exactly 'email' and 'sms'", () => {
  assert.equal(resolveUnsubscribeChannel("email"), "email");
  assert.equal(resolveUnsubscribeChannel("sms"), "sms");
});

test("resolveUnsubscribeChannel rejects anything else — null must not be treated as SMS or 'both'", () => {
  assert.equal(resolveUnsubscribeChannel(null), null);
  assert.equal(resolveUnsubscribeChannel("both"), null);
  assert.equal(resolveUnsubscribeChannel("EMAIL"), null); // no silent case coercion
  assert.equal(resolveUnsubscribeChannel(42), null);
  assert.equal(resolveUnsubscribeChannel(""), null);
  assert.equal(resolveUnsubscribeChannel(["sms"]), null);
});

// ---- buildUnsubscribeUpdate ----

const SNOOZE_ISO = "2026-09-02T00:00:00.000Z";

test("sms + stop writes only order_sms_opt_out", () => {
  assert.deepEqual(buildUnsubscribeUpdate("sms", "stop", SNOOZE_ISO), { order_sms_opt_out: true });
});

test("sms + snooze writes only order_sms_snoozed_until", () => {
  assert.deepEqual(buildUnsubscribeUpdate("sms", "snooze", SNOOZE_ISO), { order_sms_snoozed_until: SNOOZE_ISO });
});

test("email + stop writes only order_emails_opt_out", () => {
  assert.deepEqual(buildUnsubscribeUpdate("email", "stop", SNOOZE_ISO), { order_emails_opt_out: true });
});

test("email + snooze writes only order_emails_snoozed_until", () => {
  assert.deepEqual(buildUnsubscribeUpdate("email", "snooze", SNOOZE_ISO), { order_emails_snoozed_until: SNOOZE_ISO });
});

test("the two channels' update objects never share a key — opting out of one can never touch the other's columns", () => {
  for (const action of /** @type {const} */ (["snooze", "stop"])) {
    const smsKeys = Object.keys(buildUnsubscribeUpdate("sms", action, SNOOZE_ISO));
    const emailKeys = Object.keys(buildUnsubscribeUpdate("email", action, SNOOZE_ISO));
    assert.equal(smsKeys.some((k) => emailKeys.includes(k)), false);
  }
});

// ---- test-mode sentinel token ----
// Regression guard for the "unsubscribe link doesn't work" report: in test mode
// the link carries a sentinel token, and the page used to render a bare
// "not found" card — making the opt-out flow impossible to verify before
// go-live, even though the spec's checklist asked for exactly that.

test("recognizes the test-mode sentinel token", () => {
  assert.equal(isTestModeUnsubscribeToken(TEST_MODE_UNSUBSCRIBE_TOKEN), true);
  assert.equal(isTestModeUnsubscribeToken("test-mode-preview"), true);
});

test("does NOT treat a real token as the sentinel", () => {
  // A real token is a uuid; nothing about it may collide with the sentinel.
  assert.equal(isTestModeUnsubscribeToken("2f1e5a3c-9b7d-4e2a-8c6f-1d0b3a5e7c9f"), false);
  assert.equal(isTestModeUnsubscribeToken(""), false);
  assert.equal(isTestModeUnsubscribeToken("test-mode-preview-2"), false);
  assert.equal(isTestModeUnsubscribeToken("TEST-MODE-PREVIEW"), false);
});

test("the sentinel is the exact string lib/offerVars.ts mints into test-mode links", () => {
  // If this constant is ever changed without updating offerVars.ts's URL
  // construction, test-mode links silently go back to rendering "not found".
  assert.equal(TEST_MODE_UNSUBSCRIBE_TOKEN, "test-mode-preview");
});
