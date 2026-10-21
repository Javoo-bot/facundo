import test from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, scenarioById, isScenarioId, fastForwardMs } from "./scenarios.ts";

test("every scenario is uniquely identified and self-describing", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate scenario id");
  for (const s of SCENARIOS) {
    assert.ok(s.label.length > 0, s.id);
    assert.ok(s.blurb.length > 10, `${s.id} has no blurb`);
    assert.ok(s.expect.length > 20, `${s.id} does not say what it should demonstrate`);
    assert.ok(isScenarioId(s.id));
    assert.equal(scenarioById(s.id), s);
  }
});

test("unknown ids are rejected", () => {
  for (const x of ["nope", "", null, undefined, 42]) assert.equal(isScenarioId(x), false, String(x));
  assert.equal(scenarioById("nope"), undefined);
});

// The distinction the reactivation classifier turns on. A "dormant partner"
// with no accepted order is actually a never-accepted shop, and the classifier
// would correctly send it the other sequence while you wondered why.
test("the two reactivation scenarios are genuinely different states", () => {
  const never = scenarioById("joined_never_accepted");
  const dormant = scenarioById("dormant_partner");
  assert.ok(never.joinedDaysAgo !== null, "never-accepted must have joined");
  assert.equal(never.lastAcceptedDaysAgo, null, "never-accepted must have no accepted order");
  assert.ok(never.seedDeclinedOffer, "never-accepted must have been OFFERED, or the classifier refuses it");
  assert.ok(dormant.joinedDaysAgo !== null, "dormant must have joined");
  assert.ok(dormant.lastAcceptedDaysAgo !== null, "dormant must have accepted something");
});

test("dormancy is seeded well past the threshold, not on the boundary", () => {
  // A scenario that only just qualifies makes a passing test that stops passing
  // when someone tunes the threshold, for reasons unrelated to the change.
  assert.ok(scenarioById("dormant_partner").lastAcceptedDaysAgo >= 90);
  assert.ok(scenarioById("joined_never_accepted").joinedDaysAgo >= 30);
});

// The cold-offer eligibility check requires coordinates; without them the
// scenario silently exercises the "no-location" refusal instead.
test("the cold-offer target carries coordinates", () => {
  assert.equal(scenarioById("cold_offer_target").needsCoords, true);
  assert.equal(scenarioById("cold_offer_target").joinedDaysAgo, null, "a cold offer needs a NON-network shop");
});

test("prospect scenarios have never joined", () => {
  for (const id of ["fresh_prospect", "engaged_prospect", "cold_offer_target"]) {
    assert.equal(scenarioById(id).joinedDaysAgo, null, id);
  }
});

test("the engaged scenario is actually enrolled, or there is nothing to engage", () => {
  const s = scenarioById("engaged_prospect");
  assert.ok(s.engaged);
  assert.ok(s.enrolIn, "engaged without an enrolment would silently do nothing");
});

// ---- fast-forward ----

test("fast-forward converts days to milliseconds", () => {
  assert.equal(fastForwardMs(1), 24 * 60 * 60 * 1000);
  assert.equal(fastForwardMs(7), 7 * 24 * 60 * 60 * 1000);
});

test("fast-forward is bounded and never negative", () => {
  assert.equal(fastForwardMs(0), 0);
  assert.equal(fastForwardMs(-5), 0, "shifting a run FORWARD would make it due in the past twice over");
  assert.equal(fastForwardMs(99999), 400 * 24 * 60 * 60 * 1000);
  for (const v of [NaN, undefined, null, "x"]) assert.equal(fastForwardMs(v), 0, String(v));
});
