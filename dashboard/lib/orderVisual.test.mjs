// Unit tests for the shared order colour/priority keystone. Run under node's
// native TS type-stripping (imports the .ts directly):
//   node --test lib/orderVisual.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stageHue,
  requiresAttention,
  orderTone,
  orderPriority,
  isCompleted,
  compareOrders,
  toneRowClass,
  toneBadgeClass,
  primaryChip,
  secondaryChips,
  paymentNeedsAttention,
} from "./orderVisual.ts";

// Fixed clock so SLA math is deterministic.
const NOW = Date.UTC(2026, 6, 21, 12, 0, 0); // 2026-07-21T12:00:00Z
const at = (h) => new Date(NOW + h * 3600_000).toISOString(); // NOW + h hours

test("stageHue maps each stage to its muted hue", () => {
  assert.equal(stageHue("received"), "created");
  assert.equal(stageHue("matched"), "matched");
  assert.equal(stageHue("reaching_out"), "outreach");
  assert.equal(stageHue("in_production"), "fulfilment");
  assert.equal(stageHue("out_for_delivery"), "delivery");
  assert.equal(stageHue("delivered"), "delivered");
  assert.equal(stageHue("closed"), "done");
});

test("escalated is always critical attention", () => {
  const a = requiresAttention({ status: "escalated", delivery_at: at(5) }, NOW);
  assert.equal(a.attn, true);
  assert.equal(a.severity, "crit");
});

test("cancelled and clean-done orders are not attention", () => {
  for (const status of ["cancelled", "delivered", "paid", "closed"]) {
    assert.equal(requiresAttention({ status, delivery_at: at(-3) }, NOW).attn, false, status);
  }
});

test("delivered/paid with held money holds as warn attention", () => {
  const a = requiresAttention({ status: "delivered", moneyHeld: true, delivery_at: at(-1) }, NOW);
  assert.equal(a.attn, true);
  assert.equal(a.severity, "warn");
  // and it is NOT counted as completed (stays visible in the Orders list)
  assert.equal(isCompleted({ status: "delivered", moneyHeld: true }, NOW), false);
  assert.equal(orderPriority({ status: "delivered", moneyHeld: true }, NOW), 0);
});

test("money held/failed on a NON-terminal order is attention (accept-leg blind spot)", () => {
  // an accepted order whose accept-leg payout is held/failed must still flag,
  // even though the order isn't delivered/paid yet.
  const a = requiresAttention({ status: "accepted", moneyHeld: true, delivery_at: at(6) }, NOW);
  assert.equal(a.attn, true);
  assert.equal(a.severity, "warn");
  assert.equal(orderPriority({ status: "in_production", moneyHeld: true, delivery_at: at(6) }, NOW), 0);
});

test("delivered clean IS completed / priority 3", () => {
  assert.equal(isCompleted({ status: "delivered", moneyHeld: false }, NOW), true);
  assert.equal(orderPriority({ status: "delivered" }, NOW), 3);
});

test("in-flight order past its delivery deadline is overdue crit", () => {
  const a = requiresAttention({ status: "out_for_delivery", delivery_at: at(-1) }, NOW);
  assert.equal(a.severity, "crit");
  assert.match(a.reason, /overdue/i);
});

test("reaching_out with no live offer is crit; with a live offer is calmer", () => {
  const stuck = requiresAttention({ status: "reaching_out", delivery_at: at(6), assignments: [{ status: "declined" }, { status: "expired" }] }, NOW);
  assert.equal(stuck.severity, "crit");
  const live = requiresAttention({ status: "reaching_out", delivery_at: at(6), assignments: [{ status: "sent" }] }, NOW);
  assert.equal(live.attn, false); // 6h out, a live offer → no attention
  // `queued` is NOT live (it awaits a human approval in semi mode) — matches
  // cxAttention.ts, so a queued-only reaching_out order flags like the attention queue does.
  const queued = requiresAttention({ status: "reaching_out", delivery_at: at(6), assignments: [{ status: "queued" }] }, NOW);
  assert.equal(queued.severity, "crit");
});

test("matched with zero candidates means matching failed (crit); received does not flag", () => {
  assert.equal(requiresAttention({ status: "matched", candidateCount: 0, delivery_at: at(8) }, NOW).severity, "crit");
  // a freshly-received order with no candidates yet is NOT attention (awaiting matcher)
  assert.equal(requiresAttention({ status: "received", candidateCount: 0, delivery_at: at(8) }, NOW).attn, false);
  // with candidates, no attention when the deadline is far off
  assert.equal(requiresAttention({ status: "matched", candidateCount: 3, delivery_at: at(8) }, NOW).attn, false);
});

test("delivery SLA thresholds: <=30m crit, <=2h warn, beyond none", () => {
  assert.equal(requiresAttention({ status: "matched", candidateCount: 2, delivery_at: at(0.25) }, NOW).severity, "crit"); // 15m
  assert.equal(requiresAttention({ status: "matched", candidateCount: 2, delivery_at: at(1.5) }, NOW).severity, "warn"); // 90m
  assert.equal(requiresAttention({ status: "matched", candidateCount: 2, delivery_at: at(5) }, NOW).attn, false); // 5h
});

test("null / missing delivery_at never throws or flags", () => {
  assert.equal(requiresAttention({ status: "matched", candidateCount: 2, delivery_at: null }, NOW).attn, false);
  assert.equal(requiresAttention({ status: "accepted" }, NOW).attn, false);
});

test("orderTone: attention overrides stage hue", () => {
  assert.equal(orderTone({ status: "out_for_delivery", delivery_at: at(-1) }, NOW), "crit"); // overdue
  assert.equal(orderTone({ status: "delivered", moneyHeld: true }, NOW), "warn");
  assert.equal(orderTone({ status: "in_production", delivery_at: at(6) }, NOW), "fulfilment"); // calm → hue
  assert.equal(orderTone({ status: "closed" }, NOW), "done");
});

test("orderPriority buckets", () => {
  assert.equal(orderPriority({ status: "escalated" }, NOW), 0);
  assert.equal(orderPriority({ status: "reaching_out", delivery_at: at(8), assignments: [{ status: "sent" }] }, NOW), 1);
  assert.equal(orderPriority({ status: "in_production", delivery_at: at(8) }, NOW), 2);
  assert.equal(orderPriority({ status: "closed" }, NOW), 3);
});

test("compareOrders sorts by priority then deadline (nulls last)", () => {
  // deadlines kept far out so the SLA warn doesn't pull the calm ones into p0.
  const orders = [
    { status: "in_production", delivery_at: at(5) },            // p2
    { status: "escalated", delivery_at: at(9) },               // p0
    { status: "matched", candidateCount: 2, delivery_at: at(8), assignments: [] }, // p1
    { status: "reaching_out", delivery_at: at(3), assignments: [{ status: "sent" }] }, // p1, earlier deadline
    { status: "delivered" },                                    // p3
  ];
  const sorted = [...orders].sort((a, b) => compareOrders(a, b, NOW));
  assert.deepEqual(sorted.map((o) => o.status), ["escalated", "reaching_out", "matched", "in_production", "delivered"]);
});

test("toneRowClass builds the css class", () => {
  assert.equal(toneRowClass("crit"), "row-tone-crit");
  assert.equal(toneRowClass("fulfilment"), "row-tone-fulfilment");
});

test("toneBadgeClass builds the css class, mapping done to the neutral badge", () => {
  assert.equal(toneBadgeClass("crit"), "badge-crit");
  assert.equal(toneBadgeClass("fulfilment"), "badge-fulfilment");
  assert.equal(toneBadgeClass("done"), "badge-neutral");
});

test("primaryChip: attention reason wins, colored by severity", () => {
  const escalated = primaryChip({ status: "escalated" }, NOW);
  assert.equal(escalated.label, "Escalated");
  assert.equal(escalated.tone, "crit");

  const held = primaryChip({ status: "in_production", moneyHeld: true, delivery_at: at(6) }, NOW);
  assert.equal(held.label, "Payout needs review");
  assert.equal(held.tone, "warn");
});

test("primaryChip: calm order shows the plain stage label, colored by stage hue", () => {
  const calm = primaryChip({ status: "in_production", delivery_at: at(6) }, NOW);
  assert.equal(calm.label, "In production");
  assert.equal(calm.tone, "fulfilment");

  const done = primaryChip({ status: "closed" }, NOW);
  assert.equal(done.label, "Closed");
  assert.equal(done.tone, "done");
});

test("secondaryChips: payment-held is demoted UNLESS it's already the primary reason", () => {
  // moneyHeld drives the primary reason itself here → no redundant secondary chip.
  assert.deepEqual(secondaryChips({ status: "in_production", moneyHeld: true, delivery_at: at(6) }, NOW), []);

  // escalated outranks the payout reason as primary → the held money still
  // needs surfacing, quietly, as a secondary chip.
  const chips = secondaryChips({ status: "escalated", moneyHeld: true }, NOW);
  assert.deepEqual(chips, [{ label: "Payment held", tone: "warn" }]);
});

test("secondaryChips: no chips when nothing extra to say", () => {
  assert.deepEqual(secondaryChips({ status: "in_production", delivery_at: at(6) }, NOW), []);
  assert.deepEqual(secondaryChips({ status: "closed", moneyHeld: false }, NOW), []);
});

test("paymentNeedsAttention: quiet for the default paid state and unknown status", () => {
  assert.equal(paymentNeedsAttention("paid", false), false);
  assert.equal(paymentNeedsAttention("Paid", false), false); // case-insensitive
  assert.equal(paymentNeedsAttention(null, false), false);
  assert.equal(paymentNeedsAttention(undefined, false), false);
});

test("paymentNeedsAttention: notable for a held/failed payout leg regardless of Shopify status", () => {
  assert.equal(paymentNeedsAttention("paid", true), true);
  assert.equal(paymentNeedsAttention(null, true), true);
});

test("paymentNeedsAttention: notable for any non-paid Shopify financial_status", () => {
  assert.equal(paymentNeedsAttention("refunded", false), true);
  assert.equal(paymentNeedsAttention("voided", false), true);
  assert.equal(paymentNeedsAttention("pending", false), true);
});
