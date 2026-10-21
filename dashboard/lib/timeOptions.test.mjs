import { test } from "node:test";
import assert from "node:assert/strict";
import { timeOptions, STEP_MINUTES } from "./timeOptions.ts";

test("covers a full day on the half-hour grid", () => {
  const opts = timeOptions("09:00");
  assert.equal(opts.length, (24 * 60) / STEP_MINUTES);
  assert.equal(opts[0], "00:00");
  assert.equal(opts.at(-1), "23:30");
  assert.deepEqual(opts.slice(0, 4), ["00:00", "00:30", "01:00", "01:30"]);
});

test("a value already on the grid is not duplicated", () => {
  const opts = timeOptions("09:30");
  assert.equal(opts.filter((t) => t === "09:30").length, 1);
  assert.equal(opts.length, 48);
});

// The reason this function exists rather than a bare loop: real florists have
// scraped hours like 09:15, and a grid-only list would show them 09:00 or
// 09:30 as what we hold.
test("an off-grid value is offered, in sorted position", () => {
  const opts = timeOptions("09:15");
  assert.equal(opts.length, 49);
  assert.equal(opts.indexOf("09:15"), opts.indexOf("09:00") + 1);
  assert.equal(opts[opts.indexOf("09:15") + 1], "09:30");
});

test("an off-grid value after the last option lands at the end", () => {
  const opts = timeOptions("23:45");
  assert.equal(opts.at(-1), "23:45");
  assert.equal(opts.length, 49);
});

test("an off-grid value before the first lands at the start", () => {
  const opts = timeOptions("00:15");
  assert.equal(opts[1], "00:15");
  assert.equal(opts[0], "00:00");
});

test("a malformed or empty value contributes nothing to the list", () => {
  for (const bad of ["", "9:00", "24:00", "09:60", "nonsense", "09:00:00"]) {
    assert.equal(timeOptions(bad).length, 48, bad);
  }
});
