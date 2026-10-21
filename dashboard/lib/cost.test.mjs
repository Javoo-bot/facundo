// Minimal sanity assertions for the cost + duration helpers (per the brief's
// testing non-goal: a few assertions, no test framework). Run with:
//   node --test lib/cost.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { totalCost, formatUsd, formatDuration } from "./cost.ts";

test("totalCost sums, null-guarded", () => {
  assert.equal(totalCost({ llm_cost_usd: 0.4, apify_cost_usd: 0.02 }), 0.42);
  assert.equal(totalCost({ llm_cost_usd: 0.4, apify_cost_usd: null }), 0.4);
  assert.equal(totalCost({ llm_cost_usd: null, apify_cost_usd: null }), null);
});

test("formatUsd", () => {
  assert.equal(formatUsd(0.42), "$0.42");
  assert.equal(formatUsd(null), "—");
});

test("formatDuration", () => {
  assert.equal(formatDuration(192000), "3m 12s");
  assert.equal(formatDuration(44000), "44s");
  assert.equal(formatDuration(null), "—");
});
