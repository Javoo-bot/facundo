// Pure last-admin-guard logic (per the brief's testing non-goal: a few assertions,
// no test framework). Run with: node --test lib/staffRoles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { wouldRemoveLastAdmin, STAFF_ROLES } from "./staffRoles.ts";

const rows = [
  { email: "a@x.com", role: "admin" },
  { email: "b@x.com", role: "ops" },
  { email: "c@x.com", role: "admin" },
];

test("demoting a non-last admin is allowed", () => {
  assert.equal(wouldRemoveLastAdmin(rows, "a@x.com", "ops"), false);
});

test("demoting the last admin is blocked", () => {
  const oneAdmin = [rows[0], rows[1]];
  assert.equal(wouldRemoveLastAdmin(oneAdmin, "a@x.com", "ops"), true);
});

test("removing the last admin (nextRole null) is blocked", () => {
  const oneAdmin = [rows[0], rows[1]];
  assert.equal(wouldRemoveLastAdmin(oneAdmin, "a@x.com", null), true);
});

test("re-saving an admin as admin is allowed even if they're the only one", () => {
  const oneAdmin = [rows[0], rows[1]];
  assert.equal(wouldRemoveLastAdmin(oneAdmin, "a@x.com", "admin"), false);
});

test("changing a non-admin's role never trips the guard", () => {
  assert.equal(wouldRemoveLastAdmin(rows, "b@x.com", "finance"), false);
  assert.equal(wouldRemoveLastAdmin(rows, "b@x.com", null), false);
});

test("email match is case-insensitive", () => {
  const oneAdmin = [rows[0], rows[1]];
  assert.equal(wouldRemoveLastAdmin(oneAdmin, "A@X.COM", null), true);
});

test("STAFF_ROLES lists exactly the four roles", () => {
  assert.deepEqual(STAFF_ROLES, ["admin", "ops", "finance", "read_only"]);
});
