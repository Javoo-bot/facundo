import test from "node:test";
import assert from "node:assert/strict";
import { remainingBudget, isCapped, DEFAULT_DAILY_SEND_CAP } from "./sendBudget.ts";

// THE WHOLE POINT OF THIS FILE. null and 0 are adjacent in the settings UI and
// opposite in meaning; conflating them either stops a paid-for campaign at 200
// or turns the kill switch into "send everything".

test("null means no ceiling at all", () => {
  assert.equal(remainingBudget(null, 0), Infinity);
  assert.equal(remainingBudget(null, 1_500), Infinity);
  assert.equal(remainingBudget(null, 10_000_000), Infinity);
  assert.equal(isCapped(remainingBudget(null, 999_999)), false);
});

test("zero is the kill switch and is NOT unlimited", () => {
  assert.equal(remainingBudget(0, 0), 0);
  assert.ok(isCapped(remainingBudget(0, 0)), "0 must stop the tick even with nothing sent yet");
});

test("an uncapped budget survives being spent", () => {
  // tick.ts decrements this once per send and re-checks it every row; the
  // uncapped path has to stay uncapped after 1,500 decrements.
  let budget = remainingBudget(null, 0);
  for (let i = 0; i < 1_500; i++) budget--;
  assert.equal(budget, Infinity);
  assert.equal(isCapped(budget), false);
});

test("a positive cap is the blast-radius guard it always was", () => {
  assert.equal(remainingBudget(200, 0), 200);
  assert.equal(remainingBudget(200, 60), 140);
  assert.equal(remainingBudget(200, 200), 0);
  assert.ok(isCapped(remainingBudget(200, 200)));
  assert.ok(isCapped(remainingBudget(200, 250)), "over-spent counts as capped");
});

// A failed settings read is not an instruction. This is the fail-safe
// direction: bounded, not unlimited.
test("undefined falls back to the bounded default, never to unlimited", () => {
  assert.equal(remainingBudget(undefined, 0), DEFAULT_DAILY_SEND_CAP);
  assert.notEqual(remainingBudget(undefined, 0), Infinity);
});

test("a negative cap stops rather than pretending to be nearly spent", () => {
  // -5 through the old arithmetic would be a budget of -5 (capped, fine) but
  // -5 with 0 sent could read as "merely spent" elsewhere; pin it to the switch.
  assert.equal(remainingBudget(-5, 0), 0);
  assert.ok(isCapped(remainingBudget(-5, 0)));
});

test("a nonsense sentToday cannot inflate the budget", () => {
  assert.equal(remainingBudget(200, -50), 200, "negative sends must not add budget");
});

test("the 1,500-shop campaign fits when uncapped and does not when capped at 200", () => {
  const SHOPS = 1_500;
  assert.ok(remainingBudget(null, 0) >= SHOPS, "uncapped must clear a full scrape");
  assert.ok(remainingBudget(200, 0) < SHOPS, "200 is exactly what was blocking it");
});
