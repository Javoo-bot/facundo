import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEarnings, standingFor, TIER_STANDING } from "./floristStanding.ts";

test("computeEarnings: paid counts as paidOut + net", () => {
  const e = computeEarnings([{ status: "paid", amount: 70 }]);
  assert.equal(e.paidOut, 70);
  assert.equal(e.inProgress, 0);
  assert.equal(e.net, 70);
});

test("computeEarnings: issued + held are in-progress (owed, not yet released)", () => {
  const e = computeEarnings([
    { status: "issued", amount: 49 },
    { status: "held", amount: 21 },
  ]);
  assert.equal(e.paidOut, 0);
  assert.equal(e.inProgress, 70);
  assert.equal(e.net, 70);
});

test("computeEarnings: clawed_back (stored negative) reduces net, not paidOut", () => {
  const e = computeEarnings([
    { status: "paid", amount: 70 },
    { status: "clawed_back", amount: -70 },
  ]);
  assert.equal(e.paidOut, 70);
  assert.equal(e.net, 0);
});

test("computeEarnings: pending/failed never count", () => {
  const e = computeEarnings([
    { status: "pending", amount: 30 },
    { status: "failed", amount: 30 },
  ]);
  assert.deepEqual(e, { paidOut: 0, inProgress: 0, net: 0 });
});

test("computeEarnings: null amounts are treated as 0", () => {
  const e = computeEarnings([{ status: "paid", amount: null }]);
  assert.equal(e.paidOut, 0);
});

test("standingFor: known tier codes map to their label", () => {
  assert.equal(standingFor("1").label, TIER_STANDING["1"].label);
  assert.equal(standingFor("4").label, TIER_STANDING["4"].label);
});

test("standingFor: unknown / null falls back to a getting-started standing", () => {
  assert.equal(standingFor(null).label, "Getting started");
  assert.equal(standingFor("99").label, "Getting started");
});
