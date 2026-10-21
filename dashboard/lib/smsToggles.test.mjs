import test from "node:test";
import assert from "node:assert/strict";
import { smsEnabled, SMS_TOGGLE_COLUMNS } from "./smsToggles.ts";

test("explicit true enables", () => {
  assert.equal(smsEnabled({ sms_offer_enabled: true }, "offer"), true);
  assert.equal(smsEnabled({ sms_recruiting_enabled: true }, "recruiting"), true);
});

test("explicit false disables", () => {
  assert.equal(smsEnabled({ sms_offer_enabled: false }, "offer"), false);
});

test("FAILS CLOSED — unlike emailEnabled, anything other than true is off", () => {
  // This is the whole point of this module: SMS ships dark. A missing
  // settings row, a column absent from the caller's projection, or a null
  // (a settings row written before the migration) must NOT send.
  assert.equal(smsEnabled(null, "offer"), false);
  assert.equal(smsEnabled(undefined, "offer"), false);
  assert.equal(smsEnabled({}, "offer"), false);
  assert.equal(smsEnabled({ sms_offer_enabled: null }, "offer"), false);
});

test("kinds are independent", () => {
  const settings = { sms_offer_enabled: true, sms_recruiting_enabled: false };
  assert.equal(smsEnabled(settings, "offer"), true);
  assert.equal(smsEnabled(settings, "recruiting"), false);
});

test("SMS_TOGGLE_COLUMNS lists every column the module reads", () => {
  assert.deepEqual([...SMS_TOGGLE_COLUMNS].sort(), ["sms_accept_confirm_enabled", "sms_offer_enabled", "sms_recruiting_enabled"]);
});
