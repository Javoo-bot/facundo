import test from "node:test";
import assert from "node:assert/strict";
import { emailEnabled, EMAIL_TOGGLE_COLUMNS } from "./emailToggles.ts";

test("emailEnabled: defaults to true when settings is null/undefined", () => {
  assert.equal(emailEnabled(null, "offer"), true);
  assert.equal(emailEnabled(undefined, "cx_alert"), true);
});

test("emailEnabled: defaults to true when the column is missing from the projection", () => {
  assert.equal(emailEnabled({}, "offer"), true);
  assert.equal(emailEnabled({ email_offer_enabled: undefined }, "offer"), true);
});

test("emailEnabled: defaults to true when the column is explicitly null (pre-migration row)", () => {
  assert.equal(emailEnabled({ email_client_assigned_enabled: null }, "client_assigned"), true);
});

test("emailEnabled: only an explicit false disables", () => {
  assert.equal(emailEnabled({ email_recruiting_enabled: false }, "recruiting"), false);
  assert.equal(emailEnabled({ email_recruiting_enabled: true }, "recruiting"), true);
});

test("emailEnabled: reads the correct column per kind, ignoring unrelated columns", () => {
  const settings = {
    email_offer_enabled: false,
    email_client_assigned_enabled: true,
    email_client_on_the_way_enabled: false,
    email_client_delivered_enabled: true,
    email_issue_to_florist_enabled: false,
    email_issue_to_cx_enabled: true,
    email_cx_alert_enabled: false,
    email_recruiting_enabled: true,
  };
  assert.equal(emailEnabled(settings, "offer"), false);
  assert.equal(emailEnabled(settings, "client_assigned"), true);
  assert.equal(emailEnabled(settings, "client_on_the_way"), false);
  assert.equal(emailEnabled(settings, "client_delivered"), true);
  assert.equal(emailEnabled(settings, "issue_to_florist"), false);
  assert.equal(emailEnabled(settings, "issue_to_cx"), true);
  assert.equal(emailEnabled(settings, "cx_alert"), false);
  assert.equal(emailEnabled(settings, "recruiting"), true);
});

test("EMAIL_TOGGLE_COLUMNS: lists all 9 columns", () => {
  assert.equal(EMAIL_TOGGLE_COLUMNS.length, 9);
  assert.ok(EMAIL_TOGGLE_COLUMNS.includes("email_offer_enabled"));
  assert.ok(EMAIL_TOGGLE_COLUMNS.includes("email_recruiting_enabled"));
  assert.ok(EMAIL_TOGGLE_COLUMNS.includes("email_accept_confirm_enabled"));
});
