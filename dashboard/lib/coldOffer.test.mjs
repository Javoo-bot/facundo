import test from "node:test";
import assert from "node:assert/strict";
import {
  coldOfferBlockReason,
  coldOfferEligible,
  buildProvisionalActivation,
  shouldHoldAcceptLeg,
  PROVISIONAL_TIER,
  COLD_OFFER_MIN_LEAD_HOURS,
} from "./coldOffer.ts";

const NOW = Date.parse("2026-08-08T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const ON = {
  cold_offer_enabled: true,
  cold_offer_max_payout_eur: 120,
  cold_offer_auto_payout_cap_eur: 90,
  cold_offer_default_radius_km: 12,
};

const shop = (over = {}) => ({
  id: "f1",
  email: "shop@example.com",
  joined_at: null,
  excluded_at: null,
  deleted_at: null,
  lifecycle_stage: "contacted",
  order_emails_opt_out: false,
  lat: 41.98,
  lng: 2.82,
  ...over,
});

const order = (over = {}) => ({ payoutEur: 45, deliveryAt: "2026-08-10T12:00:00.000Z", ...over });

test("a well-formed cold offer is eligible", () => {
  assert.equal(coldOfferBlockReason(shop(), order(), ON, NOW), null);
  assert.ok(coldOfferEligible(shop(), order(), ON, NOW));
});

// Fail closed. This switch decides whether we put a company card in front of a
// shop nobody has checked; every unreadable-settings path must refuse.
test("it is disabled by default and by anything unreadable", () => {
  for (const s of [null, undefined, {}, { cold_offer_enabled: false }, { cold_offer_enabled: null }]) {
    assert.equal(coldOfferBlockReason(shop(), order(), s, NOW), "disabled", JSON.stringify(s));
  }
});

test("a shop that already joined is not a cold offer", () => {
  assert.equal(coldOfferBlockReason(shop({ joined_at: "2026-01-01T00:00:00Z" }), order(), ON, NOW), "already-joined");
});

test("excluded, deleted, lost and off-funnel shops are refused", () => {
  assert.equal(coldOfferBlockReason(shop({ excluded_at: "2026-01-01T00:00:00Z" }), order(), ON, NOW), "excluded");
  assert.equal(coldOfferBlockReason(shop({ deleted_at: "2026-01-01T00:00:00Z" }), order(), ON, NOW), "excluded");
  assert.equal(coldOfferBlockReason(shop({ lifecycle_stage: "lost" }), order(), ON, NOW), "lost");
  assert.equal(coldOfferBlockReason(shop({ lifecycle_stage: "off-funnel" }), order(), ON, NOW), "lost");
});

test("no email, or an opt-out, is refused", () => {
  assert.equal(coldOfferBlockReason(shop({ email: null }), order(), ON, NOW), "no-email");
  assert.equal(coldOfferBlockReason(shop({ order_emails_opt_out: true }), order(), ON, NOW), "opted-out");
});

// Without coordinates we cannot honestly claim the shop is near the delivery
// address — and the matcher could not have ranked them either.
test("a shop with no coordinates is refused", () => {
  assert.equal(coldOfferBlockReason(shop({ lat: null }), order(), ON, NOW), "no-location");
  assert.equal(coldOfferBlockReason(shop({ lng: null }), order(), ON, NOW), "no-location");
});

// The cheapest control there is: never cold-offer the expensive order.
test("the payout ceiling bounds the worst case", () => {
  assert.equal(coldOfferBlockReason(shop(), order({ payoutEur: 120 }), ON, NOW), null, "at the cap is allowed");
  assert.equal(coldOfferBlockReason(shop(), order({ payoutEur: 120.01 }), ON, NOW), "payout-too-high");
  assert.equal(coldOfferBlockReason(shop(), order({ payoutEur: 400 }), ON, NOW), "payout-too-high");
  assert.equal(coldOfferBlockReason(shop(), order({ payoutEur: null }), ON, NOW), "payout-unknown");
});

test("the payout ceiling falls back to a default when unset or garbage", () => {
  const s = { cold_offer_enabled: true };
  assert.equal(coldOfferBlockReason(shop(), order({ payoutEur: 119 }), s, NOW), null);
  assert.equal(coldOfferBlockReason(shop(), order({ payoutEur: 121 }), s, NOW), "payout-too-high");
  const junk = { cold_offer_enabled: true, cold_offer_max_payout_eur: "not-a-number" };
  assert.equal(coldOfferBlockReason(shop(), order({ payoutEur: 121 }), junk, NOW), "payout-too-high");
});

// A stranger has to read an unexpected email, decide, sign in for the first
// time, and buy flowers. A rush order asks all of that in two hours.
test("a rush order is never cold-offered", () => {
  const soon = new Date(NOW + 2 * HOUR).toISOString();
  assert.equal(coldOfferBlockReason(shop(), order({ deliveryAt: soon }), ON, NOW), "too-urgent");

  const justUnder = new Date(NOW + (COLD_OFFER_MIN_LEAD_HOURS - 0.1) * HOUR).toISOString();
  assert.equal(coldOfferBlockReason(shop(), order({ deliveryAt: justUnder }), ON, NOW), "too-urgent");

  const justOver = new Date(NOW + (COLD_OFFER_MIN_LEAD_HOURS + 0.1) * HOUR).toISOString();
  assert.equal(coldOfferBlockReason(shop(), order({ deliveryAt: justOver }), ON, NOW), null);
});

test("an order with no delivery date is not treated as urgent", () => {
  assert.equal(coldOfferBlockReason(shop(), order({ deliveryAt: null }), ON, NOW), null);
});

// ---- provisional activation ----

test("accepting mints exactly what the activation gate demands", () => {
  const a = buildProvisionalActivation(ON, "2026-08-08T09:00:00.000Z");
  assert.equal(a.trust_tier, PROVISIONAL_TIER);
  assert.equal(a.delivery_radius_km, 12);
  assert.equal(a.joined_at, "2026-08-08T09:00:00.000Z");
  assert.equal(a.provisional_source, "cold_offer");
});

// `production` is the stage that says a human vetted this shop. Nobody has.
test("a cold accept never lands in production", () => {
  assert.equal(buildProvisionalActivation(ON, "2026-08-08T09:00:00.000Z").lifecycle_stage, "onboarding");
});

test("the default radius falls back sanely", () => {
  assert.equal(buildProvisionalActivation({ cold_offer_enabled: true }, "x").delivery_radius_km, 12);
  assert.equal(buildProvisionalActivation(null, "x").delivery_radius_km, 12);
  assert.equal(buildProvisionalActivation({ cold_offer_default_radius_km: "15" }, "x").delivery_radius_km, 15);
});

// ---- the payout hold ----

test("a provisional shop's big accept leg is held; a small one pays instantly", () => {
  assert.equal(shouldHoldAcceptLeg("5", 50, ON), false, "small leg should pay instantly — that's the promise");
  assert.equal(shouldHoldAcceptLeg("5", 90, ON), false, "at the cap still pays");
  assert.equal(shouldHoldAcceptLeg("5", 91, ON), true);
});

test("only provisional shops are held — everyone else is unaffected", () => {
  for (const tier of ["1", "2", "3", "4", null, undefined]) {
    assert.equal(shouldHoldAcceptLeg(tier, 500, ON), false, `tier ${tier} was held`);
  }
});

test("an unknown amount is held rather than issued", () => {
  assert.equal(shouldHoldAcceptLeg("5", null, ON), true);
  assert.equal(shouldHoldAcceptLeg("5", Number.NaN, ON), true);
});

// A malformed address used to sail through the gate: `!florist.email` is false
// for "ana@@floristeria", so the shop looked eligible, the wave sent to it, the
// send refused with `florist-no-email`, and the candidate was closed as
// unreachable. The shop was spent on a typo and nothing recorded why.
test("a badly written address is caught by the gate, not by the sender", () => {
  const order = { payoutEur: 50, deliveryAt: new Date(NOW + 48 * HOUR).toISOString() };
  const settings = { cold_offer_enabled: true, cold_offer_max_payout_eur: 120 };
  const base = { joined_at: null, excluded_at: null, deleted_at: null, lifecycle_stage: "found", order_emails_opt_out: false, lat: 1, lng: 1 };

  assert.equal(coldOfferBlockReason({ ...base, email: "ana@floristeria.es" }, order, settings, NOW), null);

  for (const bad of ["ana@@floristeria.es", "ana floristeria.es", "@floristeria.es", "ana@", "ana@floristeria", "ana @floristeria.es"]) {
    assert.equal(coldOfferBlockReason({ ...base, email: bad }, order, settings, NOW), "bad-email", bad);
  }
  // Absent is still its own reason — "we never had one" and "we have a broken
  // one" call for different follow-ups.
  assert.equal(coldOfferBlockReason({ ...base, email: null }, order, settings, NOW), "no-email");
  // Surrounding whitespace is a storage artefact, not a bad address.
  assert.equal(coldOfferBlockReason({ ...base, email: "  ana@floristeria.es  " }, order, settings, NOW), null);
});
