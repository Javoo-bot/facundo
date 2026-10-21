import { test } from "node:test";
import assert from "node:assert/strict";
import { placeHoursToBusinessHours } from "./placeHours.ts";

/** Places numbers days from SUNDAY. Every fixture here uses the real numbering
 * on purpose — an off-by-one in the mapping shifts a shop's whole week, and a
 * fixture that used our own Monday-first order would hide exactly that bug. */
const P = (day, oh, om, cd, ch, cm) => ({
  open: { day, hour: oh, minute: om },
  ...(cd === null ? {} : { close: { day: cd, hour: ch, minute: cm } }),
});

test("no periods at all yields nothing, not a week of guesses", () => {
  assert.deepEqual(placeHoursToBusinessHours(null), { hours: null, skipped: [] });
  assert.deepEqual(placeHoursToBusinessHours([]), { hours: null, skipped: [] });
});

test("Sunday is day 0 — a Sunday period must not land on Monday", () => {
  const { hours } = placeHoursToBusinessHours([P(0, 10, 0, 0, 14, 0)]);
  assert.equal(hours.sun, "10:00-14:00");
  assert.equal(hours.mon, "closed");
});

test("a plain weekday range maps straight across", () => {
  const { hours } = placeHoursToBusinessHours([P(1, 9, 0, 1, 19, 0), P(6, 9, 30, 6, 14, 0)]);
  assert.equal(hours.mon, "09:00-19:00");
  assert.equal(hours.sat, "09:30-14:00");
});

// The whole reason this mapper is more than three lines.
test("a lunch closure becomes the two-block form", () => {
  const { hours, skipped } = placeHoursToBusinessHours([
    P(2, 9, 0, 2, 13, 0),
    P(2, 16, 0, 2, 20, 0),
  ]);
  assert.equal(hours.tue, "09:00-13:00,16:00-20:00");
  assert.deepEqual(skipped, []);
});

test("two blocks arriving out of order are sorted, not stored backwards", () => {
  const { hours } = placeHoursToBusinessHours([P(2, 16, 0, 2, 20, 0), P(2, 9, 0, 2, 13, 0)]);
  assert.equal(hours.tue, "09:00-13:00,16:00-20:00");
});

test("a day missing from the response is closed — that is what omission means", () => {
  const { hours } = placeHoursToBusinessHours([P(1, 9, 0, 1, 19, 0)]);
  assert.equal(hours.sun, "closed");
  assert.equal(hours.sat, "closed");
});

test("open 24 hours is a period with no close, and is not mistaken for closed", () => {
  const { hours } = placeHoursToBusinessHours([P(1, 0, 0, null)]);
  assert.equal(hours.mon, "00:00-23:59");
});

// Each of these would be a plausible-looking wrong answer if we guessed.
test("an overnight span is skipped, with a reason, rather than stored backwards", () => {
  const { hours, skipped } = placeHoursToBusinessHours([P(5, 18, 0, 6, 2, 0)]);
  assert.equal(hours.fri, undefined);
  assert.deepEqual(skipped, [{ day: "fri", reason: "closes on a different day (overnight)" }]);
});

test("three or more blocks in a day are skipped, not truncated to the first two", () => {
  const { hours, skipped } = placeHoursToBusinessHours([
    P(3, 8, 0, 3, 10, 0), P(3, 12, 0, 3, 14, 0), P(3, 16, 0, 3, 18, 0),
  ]);
  assert.equal(hours.wed, undefined);
  assert.equal(skipped[0].reason, "more than two opening blocks");
});

test("overlapping blocks are skipped — we cannot say which one is right", () => {
  const { skipped } = placeHoursToBusinessHours([P(4, 9, 0, 4, 14, 0), P(4, 13, 0, 4, 18, 0)]);
  assert.equal(skipped[0].reason, "opening blocks overlap");
});

test("a malformed point is dropped without taking the rest of the week with it", () => {
  const { hours } = placeHoursToBusinessHours([
    { open: { day: 1, hour: 99 }, close: { day: 1, hour: 19 } },
    P(2, 9, 0, 2, 19, 0),
  ]);
  assert.equal(hours.mon, "closed"); // nothing usable arrived for Monday
  assert.equal(hours.tue, "09:00-19:00");
});

test("everything it emits is accepted by the form's own parser", async () => {
  const { toDayRows, toBusinessHours } = await import("./businessHours.ts");
  const { hours } = placeHoursToBusinessHours([
    P(1, 9, 0, 1, 13, 0), P(1, 16, 0, 1, 20, 0), P(6, 10, 0, 6, 14, 0),
  ]);
  // Round-tripping through the join form must not change what we imported.
  assert.deepEqual(toBusinessHours(toDayRows(hours)), hours);
});
