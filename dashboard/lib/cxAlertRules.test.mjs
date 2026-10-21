import test from "node:test";
import assert from "node:assert/strict";
import { isBreaching, hashBreachingSet, BREACH_URGENCY_THRESHOLD } from "./cxAlertRules.ts";

const NOW = "2026-07-15T12:00:00.000Z";
const PAST = "2026-07-15T11:00:00.000Z";
const FUTURE = "2026-07-15T13:00:00.000Z";

function row(overrides = {}) {
  return {
    orderId: "order-1",
    orderName: "#1001",
    deliveryAt: null,
    status: "reaching_out",
    primary: { category: "place", label: "Needs next florist", urgency: 40, slaAt: null },
    others: [],
    categories: ["place"],
    unread: false,
    urgency: 40,
    ...overrides,
  };
}

test("isBreaching: urgency at/above the threshold breaches even with no SLA", () => {
  assert.equal(isBreaching(row({ urgency: BREACH_URGENCY_THRESHOLD }), NOW), true);
  assert.equal(isBreaching(row({ urgency: BREACH_URGENCY_THRESHOLD - 1 }), NOW), false);
});

test("isBreaching: a passed SLA on the primary reason breaches regardless of urgency", () => {
  const r = row({ urgency: 10, primary: { category: "delivery", label: "Late", urgency: 10, slaAt: PAST } });
  assert.equal(isBreaching(r, NOW), true);
});

test("isBreaching: a passed SLA on a secondary ('others') reason still breaches", () => {
  const r = row({
    urgency: 10,
    primary: { category: "place", label: "Awaiting reach-out", urgency: 10, slaAt: null },
    others: [{ category: "delivery", label: "Late", urgency: 85, slaAt: PAST }],
  });
  assert.equal(isBreaching(r, NOW), true);
});

test("isBreaching: a future SLA does not breach", () => {
  const r = row({ urgency: 10, primary: { category: "delivery", label: "Late", urgency: 10, slaAt: FUTURE } });
  assert.equal(isBreaching(r, NOW), false);
});

test("hashBreachingSet: order-independent — same set, different array order, same hash", () => {
  const a = [row({ orderId: "a" }), row({ orderId: "b" }), row({ orderId: "c" })];
  const b = [row({ orderId: "c" }), row({ orderId: "a" }), row({ orderId: "b" })];
  assert.equal(hashBreachingSet(a), hashBreachingSet(b));
});

test("hashBreachingSet: a changed set (order added/removed) changes the hash", () => {
  const before = [row({ orderId: "a" }), row({ orderId: "b" })];
  const added = [row({ orderId: "a" }), row({ orderId: "b" }), row({ orderId: "c" })];
  const removed = [row({ orderId: "a" })];
  assert.notEqual(hashBreachingSet(before), hashBreachingSet(added));
  assert.notEqual(hashBreachingSet(before), hashBreachingSet(removed));
});

test("hashBreachingSet: empty set is stable and distinct from any non-empty set", () => {
  assert.equal(hashBreachingSet([]), hashBreachingSet([]));
  assert.notEqual(hashBreachingSet([]), hashBreachingSet([row({ orderId: "a" })]));
});
