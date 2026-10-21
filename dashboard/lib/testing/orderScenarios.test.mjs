import test from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_SCENARIOS,
  orderScenarioById,
  isOrderScenarioId,
  UNREACHABLE_DELIVERY_POINT,
} from "./orderScenarios.ts";

test("every order scenario is uniquely identified and self-describing", () => {
  const ids = ORDER_SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate scenario id");
  for (const s of ORDER_SCENARIOS) {
    assert.ok(s.label.length > 0, s.id);
    assert.ok(s.blurb.length > 10, `${s.id} has no blurb`);
    assert.ok(s.expect.length > 20, `${s.id} does not say what it should demonstrate`);
    assert.ok(isOrderScenarioId(s.id));
    assert.equal(orderScenarioById(s.id), s);
  }
});

test("unknown ids are rejected", () => {
  for (const x of ["nope", "", null, undefined, 42]) assert.equal(isOrderScenarioId(x), false, String(x));
  assert.equal(orderScenarioById("nope"), undefined);
});

test("the escalation scenario needs no demo shop and has no assignment", () => {
  const s = orderScenarioById("no_nearby_shop_escalates");
  assert.equal(s.needsDemoShop, false);
  assert.equal(s.assignmentStatus, null);
  assert.equal(s.orderStatus, "escalated");
  assert.equal(s.sendsRealOffer, false, "nobody to offer it to");
});

test("every other scenario needs a demo shop in range", () => {
  for (const s of ORDER_SCENARIOS) {
    if (s.id === "no_nearby_shop_escalates") continue;
    assert.ok(s.needsDemoShop, s.id);
    assert.ok(s.assignmentStatus, s.id);
  }
});

test("scenarios past 'sent' actually sent a real offer first", () => {
  for (const s of ORDER_SCENARIOS) {
    if (["sent", "accepted", "delivered"].includes(s.assignmentStatus ?? "")) {
      assert.ok(s.sendsRealOffer, `${s.id} claims a status past candidate without ever sending`);
    }
  }
});

test("only the timeout scenario backdates the offer expiry", () => {
  for (const s of ORDER_SCENARIOS) {
    assert.equal(s.backdateExpiry, s.id === "offer_sent_not_accepted_timeout", s.id);
  }
});

test("accepted/delivered scenarios issue the accept-leg payout", () => {
  for (const s of ORDER_SCENARIOS) {
    if (s.assignmentStatus === "accepted" || s.assignmentStatus === "delivered") {
      assert.ok(s.issueAcceptPayout, s.id);
    }
  }
});

test("delivery verdict is set exactly for the two photo scenarios, and they disagree", () => {
  assert.equal(orderScenarioById("photo_passed_paid").deliveryVerdict, "pass");
  assert.equal(orderScenarioById("photo_review_attention").deliveryVerdict, "review");
  for (const s of ORDER_SCENARIOS) {
    if (!["photo_passed_paid", "photo_review_attention"].includes(s.id)) {
      assert.equal(s.deliveryVerdict, null, s.id);
    }
  }
});

test("a passing photo reaches order status paid; a flagged one does not", () => {
  assert.equal(orderScenarioById("photo_passed_paid").orderStatus, "paid");
  assert.notEqual(orderScenarioById("photo_review_attention").orderStatus, "paid");
});

test("the unreachable delivery point is nowhere near a real ingested city", () => {
  assert.equal(UNREACHABLE_DELIVERY_POINT.lat, 0);
  assert.equal(UNREACHABLE_DELIVERY_POINT.lng, 0);
});
