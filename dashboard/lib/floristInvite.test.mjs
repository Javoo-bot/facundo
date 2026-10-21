// Pure invite-validity decision logic (per the brief's testing non-goal: a few
// assertions, no test framework). Run with: node --test lib/floristInvite.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { canRedeemInvite } from "./floristInvite.ts";

const NOW = new Date("2026-07-21T12:00:00Z");

test("a fresh, unaccepted, matching-email invite is redeemable", () => {
  const invite = { email: "florist@shop.com", expires_at: "2026-07-28T12:00:00Z", accepted_at: null };
  assert.deepEqual(canRedeemInvite(invite, "florist@shop.com", NOW), { ok: true });
});

test("email match is case-insensitive", () => {
  const invite = { email: "Florist@Shop.com", expires_at: "2026-07-28T12:00:00Z", accepted_at: null };
  assert.deepEqual(canRedeemInvite(invite, "florist@shop.com", NOW), { ok: true });
});

test("an expired invite is rejected", () => {
  const invite = { email: "florist@shop.com", expires_at: "2026-07-20T12:00:00Z", accepted_at: null };
  assert.deepEqual(canRedeemInvite(invite, "florist@shop.com", NOW), { ok: false, reason: "expired" });
});

test("an already-accepted invite is rejected even if not expired", () => {
  const invite = { email: "florist@shop.com", expires_at: "2026-07-28T12:00:00Z", accepted_at: "2026-07-21T00:00:00Z" };
  assert.deepEqual(canRedeemInvite(invite, "florist@shop.com", NOW), { ok: false, reason: "accepted" });
});

test("accepted check wins over expiry check when both are true", () => {
  const invite = { email: "florist@shop.com", expires_at: "2026-07-20T12:00:00Z", accepted_at: "2026-07-20T13:00:00Z" };
  assert.deepEqual(canRedeemInvite(invite, "florist@shop.com", NOW), { ok: false, reason: "accepted" });
});

test("a different sign-in email is rejected", () => {
  const invite = { email: "florist@shop.com", expires_at: "2026-07-28T12:00:00Z", accepted_at: null };
  assert.deepEqual(canRedeemInvite(invite, "someoneelse@shop.com", NOW), { ok: false, reason: "email_mismatch" });
});
