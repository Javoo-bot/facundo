import test from "node:test";
import assert from "node:assert/strict";
import { computeBalance, countsTowardBalance } from "./payoutBalance.ts";

const p = (status, amount) => ({ status, amount });

test("sums issued + paid", () => {
  assert.equal(computeBalance([p("issued", 49.95), p("paid", 26.6)]), 76.55);
});

test("clawed_back (negative) reduces the balance — the bug this fixes", () => {
  assert.equal(computeBalance([p("issued", 100), p("clawed_back", -30)]), 70);
  // full clawback of an issued leg nets to zero
  assert.equal(computeBalance([p("issued", 61.46), p("clawed_back", -61.46)]), 0);
});

test("pending and failed do NOT count", () => {
  assert.equal(computeBalance([p("issued", 50), p("pending", 999), p("failed", 999)]), 50);
});

test("held counts (owed, parked for CX release) — keeps the headline in step with 'on the way'", () => {
  assert.equal(computeBalance([p("held", 21)]), 21);
  assert.equal(computeBalance([p("paid", 49), p("held", 21)]), 70);
  assert.equal(countsTowardBalance("held"), true);
});

test("null amounts are guarded (never NaN)", () => {
  assert.equal(computeBalance([p("issued", null), p("paid", 10)]), 10);
  assert.equal(computeBalance([]), 0);
});

test("rounds to cents (no float drift)", () => {
  assert.equal(computeBalance([p("issued", 0.1), p("issued", 0.2)]), 0.3);
});

test("countsTowardBalance", () => {
  assert.equal(countsTowardBalance("issued"), true);
  assert.equal(countsTowardBalance("paid"), true);
  assert.equal(countsTowardBalance("clawed_back"), true);
  assert.equal(countsTowardBalance("pending"), false);
  assert.equal(countsTowardBalance("failed"), false);
});
