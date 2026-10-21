// Sanity assertions for the Sprint 4 feedback-loop helpers (pctLabel,
// tierReviewRecommended) plus the pre-existing computePerformance /0 guard.
// Run with: node --test components/florist/floristOps.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { computePerformance, pctLabel, tierReviewRecommended } from "./floristOps.ts";

test("computePerformance guards the /0 case (no accepted/declined yet)", () => {
  const stats = computePerformance([]);
  assert.equal(stats.acceptanceRateLabel, "—");
  assert.equal(stats.assigned, 0);
});

test("pctLabel guards null/NaN rather than fabricating a number", () => {
  assert.equal(pctLabel(null), "—");
  assert.equal(pctLabel(undefined), "—");
  assert.equal(pctLabel(Number.NaN), "—");
  assert.equal(pctLabel(0.5), "50%");
  assert.equal(pctLabel(1), "100%");
});

test("tierReviewRecommended fires on >=3 declines in the recent window", () => {
  const assignments = [
    { status: "declined" },
    { status: "declined" },
    { status: "declined" },
    { status: "accepted" },
  ];
  assert.equal(tierReviewRecommended(assignments, 0), true);
});

test("tierReviewRecommended fires on >=1 issue in the recent window", () => {
  assert.equal(tierReviewRecommended([{ status: "accepted" }], 1), true);
});

test("tierReviewRecommended is false for a clean recent record", () => {
  const assignments = [{ status: "accepted" }, { status: "delivered" }, { status: "declined" }];
  assert.equal(tierReviewRecommended(assignments, 0), false);
});

test("tierReviewRecommended only looks at the recent window, not all-time history", () => {
  // 3 declines, but outside the 2-item window passed in — should not fire.
  const assignments = [{ status: "accepted" }, { status: "accepted" }, { status: "declined" }, { status: "declined" }, { status: "declined" }];
  assert.equal(tierReviewRecommended(assignments, 0, 2), false);
});
