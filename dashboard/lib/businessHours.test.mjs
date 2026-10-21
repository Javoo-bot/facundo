import test from "node:test";
import assert from "node:assert/strict";
import { expandDayKey, toDayRows, weekdaysAgree, toBusinessHours, invalidRows, HOUR_DAYS, parseRanges } from "./businessHours.ts";

const row = (rows, day) => rows.find((r) => r.day === day);

test("expands a bare day key", () => {
  assert.deepEqual(expandDayKey("sat"), ["sat"]);
});

test("expands mon_fri to the five weekdays", () => {
  assert.deepEqual(expandDayKey("mon_fri"), ["mon", "tue", "wed", "thu", "fri"]);
});

test("expands sat_sun to the weekend", () => {
  assert.deepEqual(expandDayKey("sat_sun"), ["sat", "sun"]);
});

test("expands a wrap-around range", () => {
  assert.deepEqual(expandDayKey("sun_thu"), ["sun", "mon", "tue", "wed", "thu"]);
});

test("a range whose ends are equal is a single day, not a full week", () => {
  assert.deepEqual(expandDayKey("wed_wed"), ["wed"]);
});

test("ignores keys that aren't days", () => {
  assert.deepEqual(expandDayKey("holidays"), []);
  assert.deepEqual(expandDayKey("mon_funday"), []);
  assert.deepEqual(expandDayKey(""), []);
});

test("grouped staff-entered hours pre-fill every day they cover", () => {
  // The exact shape in supabase/seed/2026-07-13-florist-demo.sql — the case
  // the old per-day-only parser dropped on the floor.
  const rows = toDayRows({ mon_fri: "09:00-20:00", sat: "09:00-15:00" });
  for (const day of ["mon", "tue", "wed", "thu", "fri"]) {
    assert.deepEqual(row(rows, day), { day, closed: false, open: "09:00", close: "20:00", open2: null, close2: null });
  }
  assert.deepEqual(row(rows, "sat"), { day: "sat", closed: false, open: "09:00", close: "15:00", open2: null, close2: null });
});

test("days no key covers fall back to the defaults", () => {
  const rows = toDayRows({ mon_fri: "09:00-20:00" });
  // Saturday defaults open, Sunday defaults closed.
  assert.deepEqual(row(rows, "sat"), { day: "sat", closed: false, open: "09:00", close: "19:00", open2: null, close2: null });
  assert.equal(row(rows, "sun").closed, true);
});

test("null and empty stored hours give the full default week", () => {
  for (const stored of [null, undefined, {}]) {
    const rows = toDayRows(stored);
    assert.equal(rows.length, 7);
    assert.deepEqual(
      rows.map((r) => r.day),
      [...HOUR_DAYS]
    );
    assert.equal(row(rows, "mon").open, "09:00");
    assert.equal(row(rows, "mon").close, "19:00");
    assert.equal(row(rows, "sat").closed, false);
    assert.equal(row(rows, "sun").closed, true);
  }
});

test("an explicit closed day is preserved", () => {
  assert.equal(row(toDayRows({ mon: "closed" }), "mon").closed, true);
});

test("unparseable values are ignored rather than guessed at", () => {
  const rows = toDayRows({ mon: "whenever", tue: "9-5", wed: 900, thu: "25:00-26:00" });
  // All four fall through to the default, none produce a garbage range.
  for (const day of ["mon", "tue", "wed", "thu"]) {
    assert.deepEqual(row(rows, day), { day, closed: false, open: "09:00", close: "19:00", open2: null, close2: null });
  }
});

test("a specific day overrides a grouped range regardless of key order", () => {
  // Same data, both serialisations — the specific key must win either way.
  for (const stored of [
    { wed: "10:00-14:00", mon_fri: "09:00-20:00" },
    { mon_fri: "09:00-20:00", wed: "10:00-14:00" },
  ]) {
    const rows = toDayRows(stored);
    assert.equal(row(rows, "wed").open, "10:00");
    assert.equal(row(rows, "wed").close, "14:00");
    assert.equal(row(rows, "mon").open, "09:00");
    assert.equal(row(rows, "mon").close, "20:00");
  }
});

test("weekdaysAgree is true when all five weekdays match", () => {
  assert.equal(weekdaysAgree(toDayRows({ mon_fri: "09:00-20:00" })), true);
});

test("weekdaysAgree is false when one weekday differs", () => {
  assert.equal(weekdaysAgree(toDayRows({ mon_fri: "09:00-20:00", wed: "10:00-14:00" })), false);
});

test("weekdaysAgree is false when one weekday is closed", () => {
  assert.equal(weekdaysAgree(toDayRows({ mon_fri: "09:00-20:00", mon: "closed" })), false);
});

test("round-trips rows back to a per-day map with closed days explicit", () => {
  const stored = toBusinessHours(toDayRows({ mon_fri: "09:00-20:00", sat: "09:00-15:00" }));
  assert.deepEqual(stored, {
    mon: "09:00-20:00",
    tue: "09:00-20:00",
    wed: "09:00-20:00",
    thu: "09:00-20:00",
    fri: "09:00-20:00",
    sat: "09:00-15:00",
    sun: "closed",
  });
});

test("a row with a blank time is dropped rather than stored half-formed", () => {
  const stored = toBusinessHours([{ day: "mon", closed: false, open: "09:00", close: "", open2: null, close2: null }]);
  assert.equal(stored, null);
});

test("invalidRows flags close-before-open and blanks, not closed days", () => {
  const rows = [
    { day: "mon", closed: false, open: "19:00", close: "09:00", open2: null, close2: null },
    { day: "tue", closed: false, open: "09:00", close: "09:00", open2: null, close2: null },
    { day: "wed", closed: false, open: "", close: "19:00", open2: null, close2: null },
    { day: "thu", closed: true, open: "", close: "", open2: null, close2: null },
    { day: "fri", closed: false, open: "09:00", close: "19:00", open2: null, close2: null },
  ];
  assert.deepEqual(
    invalidRows(rows).map((r) => r.day),
    ["mon", "tue", "wed"]
  );
});

// --- midday closure (the two-block form) ---------------------------------
// The Mediterranean lunch break is the normal shape of a florist's day in
// ES/FR/IT/PT, and until this existed the model could not represent it at all.

test("a stored lunch break round-trips through rows and back", () => {
  const rows = toDayRows({ mon: "09:00-13:00,16:00-20:00" });
  assert.deepEqual(row(rows, "mon"), {
    day: "mon", closed: false, open: "09:00", close: "13:00", open2: "16:00", close2: "20:00",
  });
  assert.equal(toBusinessHours(rows).mon, "09:00-13:00,16:00-20:00");
});

test("a grouped key with a lunch break covers every day it names", () => {
  const rows = toDayRows({ mon_fri: "09:00-13:00,16:00-20:00" });
  for (const day of ["mon", "tue", "wed", "thu", "fri"]) {
    assert.equal(row(rows, day).open2, "16:00", day);
    assert.equal(row(rows, day).close2, "20:00", day);
  }
});

test("parseRanges rejects what it cannot fully understand, rather than half-reading it", () => {
  assert.equal(parseRanges("09:00-13:00,garbage"), null);
  assert.equal(parseRanges("09:00-13:00,10:00-20:00"), null); // overlapping
  assert.equal(parseRanges("09:00-13:00,13:00-20:00"), null); // touching = not a break
  assert.equal(parseRanges("09:00-13:00,16:00-20:00,22:00-23:00"), null); // three
  assert.deepEqual(parseRanges("09:00-19:00"), [{ open: "09:00", close: "19:00" }]);
});

test("a day whose break is only half filled in is invalid", () => {
  const base = { day: "mon", closed: false, open: "09:00", close: "13:00" };
  assert.equal(invalidRows([{ ...base, open2: "16:00", close2: null }]).length, 1);
  assert.equal(invalidRows([{ ...base, open2: null, close2: "20:00" }]).length, 1);
  assert.equal(invalidRows([{ ...base, open2: "16:00", close2: "20:00" }]).length, 0);
});

test("an afternoon block that starts before the morning ends is invalid", () => {
  const base = { day: "mon", closed: false, open: "09:00", close: "16:00" };
  assert.equal(invalidRows([{ ...base, open2: "15:00", close2: "20:00" }]).length, 1);
  assert.equal(invalidRows([{ ...base, open2: "20:00", close2: "19:00" }]).length, 1);
});

test("weekdays with differing breaks do not agree, so the form stays expanded", () => {
  const rows = toDayRows({ mon_fri: "09:00-20:00", wed: "09:00-13:00,16:00-20:00" });
  assert.equal(weekdaysAgree(rows), false);
});
