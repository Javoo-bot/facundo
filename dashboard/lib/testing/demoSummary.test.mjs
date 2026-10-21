import test from "node:test";
import assert from "node:assert/strict";
import { summarizeScenarioRuns, toScenarioRunResult } from "./demoSummary.ts";

test("toScenarioRunResult: a successful outcome passes ids/steps/warnings through", () => {
  const r = toScenarioRunResult("happy_path_nearby_demo_shop", "Happy path", {
    ok: true,
    orderId: "order-1",
    floristId: "florist-1",
    assignmentId: "assign-1",
    steps: ["a", "b"],
    warnings: ["careful"],
  });
  assert.equal(r.scenarioId, "happy_path_nearby_demo_shop");
  assert.equal(r.label, "Happy path");
  assert.equal(r.ok, true);
  assert.equal(r.orderId, "order-1");
  assert.equal(r.floristId, "florist-1");
  assert.equal(r.assignmentId, "assign-1");
  assert.deepEqual(r.steps, ["a", "b"]);
  assert.deepEqual(r.warnings, ["careful"]);
  assert.equal(r.error, null);
});

test("toScenarioRunResult: a failed outcome with an explicit error string keeps it", () => {
  const r = toScenarioRunResult("no_nearby_shop_escalates", "No nearby shop", {
    ok: false,
    error: "No city with coordinates available.",
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "No city with coordinates available.");
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.orderId, null);
});

test("toScenarioRunResult: a failed outcome with NO error string still gets a readable one", () => {
  const r = toScenarioRunResult("s1", "Scenario", { ok: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, "Setup failed.");
});

test("toScenarioRunResult: a null outcome degrades to ok:false with a readable error", () => {
  const r = toScenarioRunResult("s1", "Scenario", null);
  assert.equal(r.ok, false);
  assert.equal(r.orderId, null);
  assert.equal(r.floristId, null);
  assert.equal(r.assignmentId, null);
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(typeof r.error, "string");
  assert.ok(r.error.length > 0);
});

test("toScenarioRunResult: outcome missing steps/warnings arrays defaults to empty arrays, never throws", () => {
  const r = toScenarioRunResult("s1", "Scenario", { ok: true, orderId: "o1" });
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test("toScenarioRunResult: a thrown Error is normalized to its message", () => {
  const r = toScenarioRunResult("s1", "Scenario", null, new Error("db timeout"));
  assert.equal(r.ok, false);
  assert.equal(r.error, "db timeout");
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.warnings, []);
});

test("toScenarioRunResult: a thrown Error with an empty message still yields a readable string", () => {
  const r = toScenarioRunResult("s1", "Scenario", null, new Error(""));
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, "string");
  assert.ok(r.error.length > 0);
});

test("toScenarioRunResult: a thrown plain string is used directly", () => {
  const r = toScenarioRunResult("s1", "Scenario", null, "boom");
  assert.equal(r.ok, false);
  assert.equal(r.error, "boom");
});

test("toScenarioRunResult: a thrown non-Error object degrades to a readable string, never throws", () => {
  for (const thrown of [{ weird: "object" }, 42, false, undefined, ["array", "thrown"]]) {
    // `undefined` is a JS edge case here — code paths that `throw undefined`
    // (rare, but legal) must still produce a stable result via the outcome
    // branch rather than crashing formatting. We assert only that calling
    // never throws and the shape is well-formed.
    assert.doesNotThrow(() => toScenarioRunResult("s1", "Scenario", null, thrown), JSON.stringify(thrown));
    const r = toScenarioRunResult("s1", "Scenario", null, thrown);
    assert.equal(r.ok, false, JSON.stringify(thrown));
    assert.equal(typeof r.error, "string", JSON.stringify(thrown));
  }
});

test("toScenarioRunResult: never throws even with garbage scenarioId/label", () => {
  assert.doesNotThrow(() => toScenarioRunResult(undefined, null, { ok: true }));
});

test("summarizeScenarioRuns: table of counting cases", () => {
  const cases = [
    { name: "all pass", results: [mk(true), mk(true), mk(true)], ran: 3, succeeded: 3, failed: 0 },
    { name: "all fail", results: [mk(false), mk(false)], ran: 2, succeeded: 0, failed: 2 },
    { name: "mixed", results: [mk(true), mk(false), mk(true), mk(false), mk(false)], ran: 5, succeeded: 2, failed: 3 },
    { name: "empty", results: [], ran: 0, succeeded: 0, failed: 0 },
  ];
  for (const c of cases) {
    const s = summarizeScenarioRuns(c.results);
    assert.equal(s.ran, c.ran, c.name);
    assert.equal(s.succeeded, c.succeeded, c.name);
    assert.equal(s.failed, c.failed, c.name);
    assert.equal(s.results, c.results, c.name);
  }
});

test("summarizeScenarioRuns: non-array input is treated as empty rather than throwing", () => {
  assert.doesNotThrow(() => summarizeScenarioRuns(null));
  const s = summarizeScenarioRuns(null);
  assert.equal(s.ran, 0);
  assert.equal(s.succeeded, 0);
  assert.equal(s.failed, 0);
});

function mk(ok) {
  return { scenarioId: "s", label: "l", ok, orderId: null, floristId: null, assignmentId: null, steps: [], warnings: [], error: ok ? null : "nope" };
}
