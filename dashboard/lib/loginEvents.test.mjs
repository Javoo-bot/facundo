import test from "node:test";
import assert from "node:assert/strict";
import { validateLoginEventInput } from "./loginEvents.ts";

test("validateLoginEventInput accepts a staff google login", () => {
  const result = validateLoginEventInput({ surface: "staff", method: "google", userEmail: "a@b.com" });
  assert.equal(result.ok, true);
});

test("validateLoginEventInput rejects staff surface with no email", () => {
  const result = validateLoginEventInput({ surface: "staff", method: "password" });
  assert.equal(result.ok, false);
});

test("validateLoginEventInput rejects florist surface with no floristId", () => {
  const result = validateLoginEventInput({ surface: "florist", method: "otp" });
  assert.equal(result.ok, false);
});

test("validateLoginEventInput accepts a florist magic-link login", () => {
  const result = validateLoginEventInput({ surface: "florist", method: "magic_link", floristId: "f1" });
  assert.equal(result.ok, true);
});
