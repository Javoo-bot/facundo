import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_SCENARIOS } from "./orderScenarios.ts";
import { verifyScenarioCoverage, summarizeScenarioCoverage } from "./demoQaCheck.ts";

// verifyScenarioCoverage() matches an order back to its scenario purely by
// orders.status, so that mapping only works if no two scenarios share one.
test("invariant: every scenario preset leaves the order at a distinct status", () => {
  const statuses = ORDER_SCENARIOS.map((s) => s.orderStatus);
  assert.equal(new Set(statuses).size, statuses.length, "two scenarios share an orders.status — demoQaCheck can no longer tell them apart");
});

function orderFor(scenarioId, overrides = {}) {
  const s = ORDER_SCENARIOS.find((x) => x.id === scenarioId);
  const assignments = s.assignmentStatus === null ? [] : [{ status: s.assignmentStatus }];
  return { id: `order-${scenarioId}`, status: s.orderStatus, is_demo: true, order_assignments: assignments, ...overrides };
}

const ALL_COVERED = ORDER_SCENARIOS.map((s) => orderFor(s.id));

test("verifyScenarioCoverage: every scenario present with the right assignment pattern", () => {
  const results = verifyScenarioCoverage(ALL_COVERED);
  assert.equal(results.length, ORDER_SCENARIOS.length);
  for (const r of results) {
    assert.equal(r.present, true, r.scenarioId);
    assert.equal(r.assignmentOk, true, r.scenarioId);
    assert.deepEqual(r.issues, [], r.scenarioId);
    assert.ok(r.orderId, r.scenarioId);
  }
});

test("summarizeScenarioCoverage: all covered rolls up to ok:true with nothing missing/mismatched", () => {
  const summary = summarizeScenarioCoverage(verifyScenarioCoverage(ALL_COVERED));
  assert.equal(summary.ok, true);
  assert.equal(summary.total, ORDER_SCENARIOS.length);
  assert.equal(summary.covered, ORDER_SCENARIOS.length);
  assert.deepEqual(summary.missing, []);
  assert.deepEqual(summary.mismatched, []);
});

test("verifyScenarioCoverage: no orders at all — every scenario reads as missing", () => {
  const results = verifyScenarioCoverage([]);
  assert.equal(results.length, ORDER_SCENARIOS.length);
  for (const r of results) {
    assert.equal(r.present, false, r.scenarioId);
    assert.equal(r.assignmentOk, false, r.scenarioId);
    assert.equal(r.orderId, null, r.scenarioId);
    assert.ok(r.issues[0].includes("No demo order found"), r.scenarioId);
  }
  const summary = summarizeScenarioCoverage(results);
  assert.equal(summary.ok, false);
  assert.equal(summary.covered, 0);
  assert.equal(summary.missing.length, ORDER_SCENARIOS.length);
});

test("verifyScenarioCoverage: null/undefined/non-array input is treated as empty, never throws", () => {
  for (const bad of [null, undefined, "nope", 42, {}]) {
    assert.doesNotThrow(() => verifyScenarioCoverage(bad));
    const results = verifyScenarioCoverage(bad);
    assert.ok(results.every((r) => r.present === false));
  }
});

test("verifyScenarioCoverage: an order present but with the wrong assignment status is flagged, not silently passed", () => {
  const orders = ORDER_SCENARIOS.map((s) =>
    s.id === "accepted_waiting_photo" ? orderFor(s.id, { order_assignments: [{ status: "sent" }] }) : orderFor(s.id)
  );
  const results = verifyScenarioCoverage(orders);
  const bad = results.find((r) => r.scenarioId === "accepted_waiting_photo");
  assert.equal(bad.present, true);
  assert.equal(bad.assignmentOk, false);
  assert.match(bad.issues[0], /expected an assignment with status "accepted"/i);

  const summary = summarizeScenarioCoverage(results);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.mismatched, ["accepted_waiting_photo"]);
  assert.deepEqual(summary.missing, []);
});

test("verifyScenarioCoverage: the escalation scenario is flagged if an assignment exists when it shouldn't", () => {
  const orders = ORDER_SCENARIOS.map((s) =>
    s.id === "no_nearby_shop_escalates" ? orderFor(s.id, { order_assignments: [{ status: "candidate" }] }) : orderFor(s.id)
  );
  const results = verifyScenarioCoverage(orders);
  const escalation = results.find((r) => r.scenarioId === "no_nearby_shop_escalates");
  assert.equal(escalation.present, true);
  assert.equal(escalation.assignmentOk, false);
  assert.match(escalation.issues[0], /expected no assignment, found 1/i);
});

test("verifyScenarioCoverage: rows explicitly marked is_demo:false are ignored", () => {
  const orders = ALL_COVERED.map((o) => (o.id === "order-happy_path_nearby_demo_shop" ? { ...o, is_demo: false } : o));
  const results = verifyScenarioCoverage(orders);
  const happy = results.find((r) => r.scenarioId === "happy_path_nearby_demo_shop");
  assert.equal(happy.present, false);
});

test("verifyScenarioCoverage: when two orders share a status, the earlier one in the input (newest-first) wins", () => {
  const older = orderFor("happy_path_nearby_demo_shop", { id: "older" });
  const newer = orderFor("happy_path_nearby_demo_shop", { id: "newer" });
  const results = verifyScenarioCoverage([newer, older]);
  const happy = results.find((r) => r.scenarioId === "happy_path_nearby_demo_shop");
  assert.equal(happy.orderId, "newer");
});

test("verifyScenarioCoverage: missing order_assignments array on the order is treated as zero assignments, never throws", () => {
  const orders = ORDER_SCENARIOS.map((s) => {
    const o = orderFor(s.id);
    delete o.order_assignments;
    return o;
  });
  assert.doesNotThrow(() => verifyScenarioCoverage(orders));
  const results = verifyScenarioCoverage(orders);
  const escalation = results.find((r) => r.scenarioId === "no_nearby_shop_escalates");
  assert.equal(escalation.assignmentOk, true, "escalation scenario expects zero assignments already");
  const happy = results.find((r) => r.scenarioId === "happy_path_nearby_demo_shop");
  assert.equal(happy.assignmentOk, false, "scenarios needing an assignment should fail when the array is absent");
});
