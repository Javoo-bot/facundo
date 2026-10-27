import test from "node:test";
import assert from "node:assert/strict";
import { CLUSTER_RULE, wilsonLower, judgeCluster } from "./cluster-rule.mjs";

test("the owner's values are the defaults", () => {
  assert.deepEqual(
    [CLUSTER_RULE.casesPerOccasionAbove, CLUSTER_RULE.minOccasions, CLUSTER_RULE.minDistinctDays],
    [20, 5, 3],
  );
});

test("the Wilson lower bound matches a worked value and stays inside [0, 1]", () => {
  // 21 of 200 at z=1.96: p=0.105, interval about 0.0697 to 0.1553.
  assert.ok(Math.abs(wilsonLower(21, 200) - 0.0697) < 0.0005);
  assert.equal(wilsonLower(0, 50), 0);
  assert.ok(wilsonLower(50, 50) < 1 && wilsonLower(50, 50) > 0.9);
  assert.equal(wilsonLower(3, 0), 0);
});

const days = ["d1", "d2", "d3", "d4", "d5", "d6"];
const map = (pairs) => new Map(pairs);

test("five significant days with more than 20 cases each make a card; any one missing does not", () => {
  const totals = map(days.map((d) => [d, 200]));
  assert.equal(judgeCluster(map(days.slice(0, 5).map((d) => [d, 30])), totals, days).card, true);
  assert.equal(judgeCluster(map(days.slice(0, 4).map((d) => [d, 30])), totals, days).card, false);
  const oneSmall = map(days.slice(0, 5).map((d, i) => [d, i === 0 ? 20 : 30]));
  assert.equal(judgeCluster(oneSmall, totals, days).card, false);
});

test("a day only counts when its rate is significantly above the baseline", () => {
  const big = map(days.map((d) => [d, 30]));
  assert.equal(judgeCluster(big, map(days.map((d) => [d, 300])), days).card, true, "10% of 300: lower bound about 7%");
  assert.equal(judgeCluster(big, map(days.map((d) => [d, 700])), days).card, false, "4.3% of 700 is within the noise floor");
});

test("the distinct-days rule is configurable and checked", () => {
  const rule = { ...CLUSTER_RULE, minOccasions: 1, minDistinctDays: 3 };
  const totals = map(days.map((d) => [d, 100]));
  assert.equal(judgeCluster(map([["d1", 40], ["d2", 40]]), totals, days, rule).card, false);
  assert.equal(judgeCluster(map([["d1", 40], ["d2", 40], ["d3", 40]]), totals, days, rule).card, true);
});
