import test from "node:test";
import assert from "node:assert/strict";
import { parseStatsRange } from "./statsRange.ts";
import { defaultRange } from "./opsStats.ts";

test("parseStatsRange takes a well-formed range straight from the URL", () => {
  assert.deepEqual(parseStatsRange({ from: "2026-07-01", to: "2026-07-31" }), {
    from: "2026-07-01",
    to: "2026-07-31",
  });
});

test("parseStatsRange accepts a single-day range", () => {
  assert.deepEqual(parseStatsRange({ from: "2026-07-01", to: "2026-07-01" }), {
    from: "2026-07-01",
    to: "2026-07-01",
  });
});

test("parseStatsRange falls back to the default rather than refusing to render", () => {
  const fallback = defaultRange();
  for (const sp of [
    {},
    { from: "2026-07-01" },                       // half a range
    { to: "2026-07-31" },
    { from: "01/07/2026", to: "31/07/2026" },     // not ISO
    { from: "2026-08-31", to: "2026-08-01" },     // end before start
    { from: ["2026-07-01"], to: "2026-07-31" },   // repeated param -> string[]
  ]) {
    assert.deepEqual(parseStatsRange(sp), fallback, JSON.stringify(sp));
  }
});
