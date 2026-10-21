import test from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_STATUSES, isOrderStatus, canTransition, nextOrderStatuses,
  ASSIGNMENT_STATUSES, isAssignmentStatus, statusAfterRefill,
} from "./orderStatus.ts";

test("order statuses cover the §G state machine", () => {
  for (const s of ["received","matched","reaching_out","accepted","in_production","ready","delivered","paid","closed","escalated","cancelled"]) {
    assert.ok(ORDER_STATUSES.includes(s), `${s} missing`);
  }
});

test("isOrderStatus guards unknown values", () => {
  assert.equal(isOrderStatus("received"), true);
  assert.equal(isOrderStatus("banana"), false);
  assert.equal(isOrderStatus(null), false);
});

test("legal transitions follow the state machine", () => {
  assert.equal(canTransition("received", "matched"), true);
  assert.equal(canTransition("accepted", "in_production"), true);
  assert.equal(canTransition("delivered", "paid"), true);
  assert.equal(canTransition("received", "paid"), false);   // no skipping
  assert.equal(canTransition("closed", "received"), false); // terminal
});

test("cancelled/escalated are reachable from most live states", () => {
  assert.ok(nextOrderStatuses("reaching_out").includes("escalated"));
  assert.ok(nextOrderStatuses("accepted").includes("cancelled"));
});

test("assignment statuses include the offer lifecycle", () => {
  for (const s of ["candidate","queued","sent","opened","declined","expired","accepted","reassigned","delivered"]) {
    assert.ok(ASSIGNMENT_STATUSES.includes(s), `${s} missing`);
  }
  assert.equal(isAssignmentStatus("accepted"), true);
  assert.equal(isAssignmentStatus("nope"), false);
});

// statusAfterRefill — the rule that decides whether "Find more florists" is a
// dead end. An escalated order that stays escalated is invisible to
// advanceWaves(), so its fresh candidates are never offered (2026-09-01).
test("a refill puts a received or escalated order back where the wave engine looks", () => {
  assert.equal(statusAfterRefill("received"), "matched");
  assert.equal(statusAfterRefill("escalated"), "matched");
});

test("a refill never pulls a live or finished order backwards", () => {
  for (const s of [
    "matched", "reaching_out", "accepted", "in_production", "ready",
    "out_for_delivery", "delivered", "paid", "closed", "cancelled",
  ]) {
    assert.equal(statusAfterRefill(s), null, `${s} must be left alone`);
  }
});

test("every order status has a defined refill outcome", () => {
  for (const s of ORDER_STATUSES) {
    const next = statusAfterRefill(s);
    assert.ok(next === null || next === "matched", `${s} gave ${next}`);
  }
});
