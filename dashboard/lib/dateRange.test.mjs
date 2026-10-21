import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, daysInMonth, formatDay, formatRangeLabel, isDaySelectable, isoLocalDay,
  isoMadridDay, lastSelectableOnOrBefore, monthLabel, monthMatrix, parseIsoDay,
  presetForRange, rangeLengthDays, shiftMonth, todayIso, yesterdayIso,
} from "./dateRange.ts";

// A fixed "now" for every label/preset assertion, given as an absolute INSTANT
// rather than as local calendar parts: 4 September 2026, 12:00 UTC = 14:00 in
// Madrid. Written this way so the suite asserts the same thing on a laptop in
// Spain and on a CI runner in UTC — the helpers are pinned to Madrid, so a test
// that fed them host-local parts would be asserting the runner's timezone.
const NOW = new Date("2026-09-04T12:00:00Z");

test("isoLocalDay reads the local calendar, not UTC", () => {
  // 23:30 local on the 4th is the 4th here even where UTC has already rolled
  // over to the 5th — the old `toISOString().slice(0,10)` returned the 5th.
  assert.equal(isoLocalDay(new Date(2026, 8, 4, 23, 30)), "2026-09-04");
  assert.equal(isoLocalDay(new Date(2026, 0, 1, 0, 15)), "2026-01-01");
});

test("todayIso / yesterdayIso straddle a month boundary", () => {
  assert.equal(todayIso(NOW), "2026-09-04");
  assert.equal(yesterdayIso(NOW), "2026-09-03");
  assert.equal(yesterdayIso(new Date("2026-09-01T12:00:00Z")), "2026-08-31");
  assert.equal(yesterdayIso(new Date("2026-01-01T12:00:00Z")), "2025-12-31");
});

test("todayIso is the Madrid day, not the host's", () => {
  // 23:30 UTC on 4 Sep is 01:30 on the 5th in Madrid (+02 in summer). A UTC
  // host must still answer "5 September", or the server-rendered default range
  // would disagree with the browser for the first two hours of every day.
  assert.equal(isoMadridDay(new Date("2026-09-04T23:30:00Z")), "2026-09-05");
  assert.equal(todayIso(new Date("2026-09-04T23:30:00Z")), "2026-09-05");
  // 21:00 UTC is 23:00 Madrid — same day, still the 4th.
  assert.equal(isoMadridDay(new Date("2026-09-04T21:00:00Z")), "2026-09-04");
  // Winter is +01, not +02: 23:30 UTC on 15 Jan is 00:30 on the 16th.
  assert.equal(isoMadridDay(new Date("2026-01-15T23:30:00Z")), "2026-01-16");
  assert.equal(isoMadridDay(new Date("2026-01-15T22:30:00Z")), "2026-01-15");
});

test("parseIsoDay rejects what a hand-edited URL can carry", () => {
  assert.deepEqual(parseIsoDay("2026-09-04"), { year: 2026, month: 9, day: 4 });
  for (const bad of ["", "2026-9-4", "04/09/2026", "2026-13-01", "2026-02-30", "2026-00-10", "2026-09-00"]) {
    assert.equal(parseIsoDay(bad), null, bad);
  }
  assert.deepEqual(parseIsoDay("2024-02-29"), { year: 2024, month: 2, day: 29 }); // leap day is valid
});

test("daysInMonth handles February in both kinds of year", () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 9), 30);
  assert.equal(daysInMonth(2026, 12), 31);
});

test("addDays rolls over months and years in both directions", () => {
  assert.equal(addDays("2026-09-04", 1), "2026-09-05");
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("nonsense", 1), "nonsense"); // degrades, never throws
});

test("rangeLengthDays counts both ends", () => {
  assert.equal(rangeLengthDays("2026-09-04", "2026-09-04"), 1);
  assert.equal(rangeLengthDays("2026-09-01", "2026-09-30"), 30);
  assert.equal(rangeLengthDays("2026-09-30", "2026-09-01"), 0); // reversed -> 0, not negative
});

test("shiftMonth is 1-indexed and rolls the year", () => {
  assert.deepEqual(shiftMonth(2026, 9, 1), { year: 2026, month: 10 });
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 1, -13), { year: 2024, month: 12 });
  assert.equal(monthLabel(2026, 9), "September 2026");
});

test("monthMatrix lays whole Monday-started weeks over the month", () => {
  // September 2026 starts on a Tuesday and has 30 days -> one leading blank,
  // five weeks exactly.
  const sep = monthMatrix(2026, 9);
  assert.equal(sep.length, 5);
  for (const w of sep) assert.equal(w.length, 7);
  assert.equal(sep[0][0], null);
  assert.equal(sep[0][1], "2026-09-01");
  assert.equal(sep[4][2], "2026-09-30");
  assert.equal(sep[4][3], null);

  // Every real day appears exactly once, in order, with no gaps.
  const days = sep.flat().filter(Boolean);
  assert.equal(days.length, 30);
  assert.deepEqual(days, [...Array(30)].map((_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`));
});

test("monthMatrix does not force a sixth empty week", () => {
  // February 2026 starts Sunday: 6 leading blanks + 28 days = 34 cells -> 5 weeks.
  assert.equal(monthMatrix(2026, 2).length, 5);
  // February 2027 starts Monday and has 28 days: exactly 4 weeks, no blanks.
  const feb27 = monthMatrix(2027, 2);
  assert.equal(feb27.length, 4);
  assert.equal(feb27.flat().filter((d) => d === null).length, 0);
});

test("formatDay drops the year only for the current one", () => {
  assert.equal(formatDay("2026-09-04", NOW), "4 Sep");
  assert.equal(formatDay("2025-12-31", NOW), "31 Dec 2025");
});

test("formatRangeLabel names today and yesterday, dates everything else", () => {
  assert.equal(formatRangeLabel("2026-09-04", "2026-09-04", NOW), "Today");
  assert.equal(formatRangeLabel("2026-09-03", "2026-09-03", NOW), "Yesterday");
  assert.equal(formatRangeLabel("2026-09-02", "2026-09-02", NOW), "2 Sep");
  assert.equal(formatRangeLabel("2026-09-01", "2026-09-04", NOW), "1 Sep – 4 Sep");
  assert.equal(formatRangeLabel("2025-12-30", "2026-01-02", NOW), "30 Dec 2025 – 2 Jan");
});

test("presetForRange lights at most one button", () => {
  assert.equal(presetForRange("2026-09-04", "2026-09-04", NOW), "today");
  assert.equal(presetForRange("2026-09-03", "2026-09-03", NOW), "yesterday");
  // A window that merely ends today is custom now — the old 7d/30d/90d presets
  // are gone and nothing should light up for them.
  assert.equal(presetForRange("2026-08-28", "2026-09-04", NOW), "custom");
  assert.equal(presetForRange("2026-09-03", "2026-09-04", NOW), "custom");
});

// ---- day availability -----------------------------------------------------
// Modelled on the real production shape read on 2026-09-04: orders every day
// from 24 July onward EXCEPT the 25th, which is a genuine gap between two
// trading days and the exact case a min/max span would wrongly allow.
const ACTIVE = new Set(["2026-07-24", "2026-07-26", "2026-09-02", "2026-09-03"]);

test("isDaySelectable blocks the future", () => {
  assert.equal(isDaySelectable("2026-09-05", ACTIVE, NOW), false);
  assert.equal(isDaySelectable("2027-01-01", ACTIVE, NOW), false);
  assert.equal(isDaySelectable("2026-09-05", null, NOW), false); // even with no list
});

test("isDaySelectable blocks days we hold nothing for", () => {
  assert.equal(isDaySelectable("2026-07-25", ACTIVE, NOW), false); // the gap day
  assert.equal(isDaySelectable("2026-01-14", ACTIVE, NOW), false); // before the first order
  assert.equal(isDaySelectable("2026-07-24", ACTIVE, NOW), true);
  assert.equal(isDaySelectable("2026-09-03", ACTIVE, NOW), true);
});

test("isDaySelectable always allows today, even with no data yet", () => {
  // 4 Sep is deliberately NOT in ACTIVE: before the first order of the morning
  // lands, today still has to be pickable — it is the default range.
  assert.equal(ACTIVE.has("2026-09-04"), false);
  assert.equal(isDaySelectable("2026-09-04", ACTIVE, NOW), true);
});

test("isDaySelectable opens up rather than locks down when the list is missing", () => {
  // A missing RPC must not produce a calendar where nothing can be clicked.
  assert.equal(isDaySelectable("2026-01-14", null, NOW), true);
  assert.equal(isDaySelectable("2026-07-25", null, NOW), true);
});

test("lastSelectableOnOrBefore walks back to a day we have", () => {
  assert.equal(lastSelectableOnOrBefore("2026-07-25", ACTIVE, NOW), "2026-07-24");
  assert.equal(lastSelectableOnOrBefore("2026-09-03", ACTIVE, NOW), "2026-09-03");
  assert.equal(lastSelectableOnOrBefore("2026-07-23", ACTIVE, NOW), null); // nothing before the first
  assert.equal(lastSelectableOnOrBefore("2026-07-25", null, NOW), "2026-07-25");
  assert.equal(lastSelectableOnOrBefore("2027-05-05", null, NOW), "2026-09-04"); // clamped to today
});
