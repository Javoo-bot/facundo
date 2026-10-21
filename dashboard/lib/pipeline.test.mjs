import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLifecycleStage,
  shouldBumpToContacted,
  phaseOf,
  phaseCounts,
  PHASES,
} from "./pipeline.ts";

test("isLifecycleStage accepts the 7 stages, rejects others", () => {
  for (const s of ["found", "targeted", "contacted", "engaged", "onboarding", "production", "lost"]) {
    assert.equal(isLifecycleStage(s), true);
  }
  assert.equal(isLifecycleStage("won"), false);
  assert.equal(isLifecycleStage(null), false);
  assert.equal(isLifecycleStage(3), false);
});

test("shouldBumpToContacted only from found/targeted", () => {
  assert.equal(shouldBumpToContacted("found"), true);
  assert.equal(shouldBumpToContacted("targeted"), true);
  assert.equal(shouldBumpToContacted("contacted"), false);
  assert.equal(shouldBumpToContacted("engaged"), false);
  assert.equal(shouldBumpToContacted(null), false);
});

test("phaseOf maps stages to macro-phases; lost is off-funnel", () => {
  assert.equal(phaseOf("found"), "discovery");
  assert.equal(phaseOf("contacted"), "discovery");
  assert.equal(phaseOf("engaged"), "engagement");
  assert.equal(phaseOf("onboarding"), "onboarding");
  assert.equal(phaseOf("production"), "production");
  assert.equal(phaseOf("lost"), "lost");
});

test("phaseCounts tallies per phase; lost and null excluded from phase tiles", () => {
  const counts = phaseCounts(["found", "targeted", "contacted", "engaged", "onboarding", "production", "lost", null]);
  assert.deepEqual(counts, { discovery: 4, engagement: 1, onboarding: 1, production: 1 });
  // null defaults to 'found' → discovery. 3 explicit discovery + 1 null = 4.
  assert.deepEqual(PHASES, ["discovery", "engagement", "onboarding", "production"]);
});
