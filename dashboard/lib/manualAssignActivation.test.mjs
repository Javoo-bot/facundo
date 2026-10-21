// the owner, 2026-10-14: a shop staff attach to an order by hand (POST
// /api/orders/assign, which bypasses the onboarded filter) is activated on
// accept exactly the way a cold-offer shop is. These tests pin the chain
// assign → stamped audience → what the accept routes mint.
import test from "node:test";
import assert from "node:assert/strict";
import {
  manualAssignAudience,
  provisionalSourceOnAccept,
  buildProvisionalActivation,
  PROVISIONAL_TIER,
} from "./coldOffer.ts";

const prospect = { joined_at: null, lifecycle_stage: "found" };

test("a manual assign of a shop that never joined activates it on accept", () => {
  const audience = manualAssignAudience(prospect);
  assert.equal(audience, "manual");
  assert.equal(provisionalSourceOnAccept(audience), "manual_assign");
});

test("the cold-offer accept still activates, and still says it was a cold offer", () => {
  assert.equal(provisionalSourceOnAccept("cold"), "cold_offer");
});

test("an ordinary network offer never activates anyone", () => {
  assert.equal(provisionalSourceOnAccept("network"), null);
  assert.equal(provisionalSourceOnAccept(undefined), null);
  assert.equal(provisionalSourceOnAccept(null), null);
});

test("a manual assign of an already-joined or onboarded shop changes nothing", () => {
  const shapes = [
    { joined_at: "2026-09-01T00:00:00Z", lifecycle_stage: "found" },
    { joined_at: null, lifecycle_stage: "onboarding" },
    { joined_at: null, lifecycle_stage: "production" },
    { joined_at: "2026-09-01T00:00:00Z", lifecycle_stage: "production" },
  ];
  for (const f of shapes) {
    const audience = manualAssignAudience(f);
    assert.equal(audience, "network", JSON.stringify(f));
    assert.equal(provisionalSourceOnAccept(audience), null, JSON.stringify(f));
  }
});

// lib/testing/demoSandbox.ts creates every demo shop production + joined, so a
// demo shop attached by hand never reaches the mint.
test("a /testing demo shop attached by hand is not activated", () => {
  const demoShop = { joined_at: "2026-10-14T09:00:00Z", lifecycle_stage: "production" };
  assert.equal(provisionalSourceOnAccept(manualAssignAudience(demoShop)), null);
});

test("a manual-assign activation writes the same tier, radius and stage as a cold one", () => {
  const settings = { cold_offer_default_radius_km: 15 };
  const now = "2026-10-14T09:00:00.000Z";
  const cold = buildProvisionalActivation(settings, now, "cold_offer");
  const manual = buildProvisionalActivation(settings, now, "manual_assign");
  assert.equal(manual.trust_tier, PROVISIONAL_TIER);
  assert.deepEqual({ ...manual, provisional_source: "x" }, { ...cold, provisional_source: "x" });
  assert.equal(manual.provisional_source, "manual_assign");
});
