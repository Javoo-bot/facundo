// Sanity assertions for the onboarding activation gate (Sprint 3). Run with:
//   node --test lib/floristActivation.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { computeActivation } from "./floristActivation.ts";

test("activatable requires login + radius + tier, all three present", () => {
  const status = computeActivation({ delivery_radius_km: 10, trust_tier: "2" }, true);
  assert.equal(status.activatable, true);
  assert.equal(status.checklist.length, 3);
  assert.ok(status.checklist.every((c) => c.met));
});

test("not activatable when login is missing", () => {
  const status = computeActivation({ delivery_radius_km: 10, trust_tier: "2" }, false);
  assert.equal(status.activatable, false);
  const login = status.checklist.find((c) => c.label.includes("login"));
  assert.equal(login.met, false);
});

test("not activatable when radius or tier is null", () => {
  assert.equal(computeActivation({ delivery_radius_km: null, trust_tier: "2" }, true).activatable, false);
  assert.equal(computeActivation({ delivery_radius_km: 10, trust_tier: null }, true).activatable, false);
});
