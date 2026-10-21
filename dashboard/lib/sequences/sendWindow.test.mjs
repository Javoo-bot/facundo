import test from "node:test";
import assert from "node:assert/strict";
import {
  isWithinWindow,
  nextSendTime,
  WINDOW_OPEN_HOUR,
  WINDOW_CLOSE_HOUR,
  CAMPAIGN_TIME_ZONE,
} from "./sendWindow.ts";

const TZ = CAMPAIGN_TIME_ZONE;

/** The local wall clock at `ms`, as "HH:MM", in the campaign zone. */
const localHM = (ms) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));

const localDate = (ms) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));

// Madrid is UTC+2 in summer (CEST) and UTC+1 in winter (CET).
const SUMMER_0900 = Date.parse("2026-08-03T07:00:00.000Z"); // Mon 09:00 Madrid
const WINTER_0900 = Date.parse("2026-12-07T08:00:00.000Z"); // Mon 09:00 Madrid

test("business hours are the window, and the edges belong to the right side", () => {
  assert.equal(isWithinWindow(SUMMER_0900), true, "09:00 must be inside");
  assert.equal(isWithinWindow(SUMMER_0900 - 60 * 1000), false, "08:59 must be outside");
  // 20:00 is the close and is exclusive — nothing may go out at eight.
  const eightPm = SUMMER_0900 + (WINDOW_CLOSE_HOUR - WINDOW_OPEN_HOUR) * 3600_000;
  assert.equal(localHM(eightPm), "20:00");
  assert.equal(isWithinWindow(eightPm), false, "the close hour must be exclusive");
  assert.equal(isWithinWindow(eightPm - 1), true, "19:59:59 must still be inside");
});

test("a due time already inside the window is returned UNCHANGED", () => {
  // Load-bearing: if this shifted even a millisecond, every step's clock would
  // drift a little on each hop and the 3.5h/8h offsets would stop meaning what
  // they say.
  const midday = SUMMER_0900 + 3 * 3600_000;
  assert.equal(nextSendTime(midday), midday);
});

test("before the window, a touch waits for this morning's open", () => {
  const threeAm = Date.parse("2026-08-03T01:00:00.000Z"); // 03:00 Madrid
  const out = nextSendTime(threeAm);
  assert.equal(localHM(out), "09:00");
  assert.equal(localDate(out), localDate(threeAm), "jumped to the wrong day");
  assert.ok(out > threeAm);
});

// The case this file exists to prevent: a shop enrolled overnight must not be
// judged a non-opener before anyone could have opened anything.
test("a 02:00 enrolment is deferred to 09:00, not sent at 02:00", () => {
  const twoAm = Date.parse("2026-08-03T00:00:00.000Z"); // 02:00 Madrid
  assert.equal(isWithinWindow(twoAm), false);
  assert.equal(localHM(nextSendTime(twoAm)), "09:00");
});

test("after the window, a touch rolls to the NEXT day's open", () => {
  const nineThirtyPm = Date.parse("2026-08-03T19:30:00.000Z"); // 21:30 Madrid
  const out = nextSendTime(nineThirtyPm);
  assert.equal(localHM(out), "09:00");
  assert.notEqual(localDate(out), localDate(nineThirtyPm), "stayed on the same day");
  assert.ok(out > nineThirtyPm);
});

test("the window is wall-clock in both halves of the year, not a fixed UTC offset", () => {
  // The whole reason for computing from a timezone NAME. In summer 09:00 Madrid
  // is 07:00Z; in winter it is 08:00Z. A hard-coded offset would send an hour
  // early or late for half the year — silently.
  assert.equal(localHM(SUMMER_0900), "09:00");
  assert.equal(localHM(WINTER_0900), "09:00");
  assert.equal(isWithinWindow(SUMMER_0900), true);
  assert.equal(isWithinWindow(WINTER_0900), true);

  const summerNight = Date.parse("2026-08-03T01:00:00.000Z");
  const winterNight = Date.parse("2026-12-07T02:00:00.000Z");
  assert.equal(localHM(nextSendTime(summerNight)), "09:00");
  assert.equal(localHM(nextSendTime(winterNight)), "09:00");
});

test("rolling over the spring-forward night still lands on 09:00", () => {
  // Europe/Madrid springs forward on 2026-03-29: that local day is 23 hours
  // long, so adding a flat 24h to the previous evening overshoots to 10:00.
  const eveningBefore = Date.parse("2026-03-28T21:00:00.000Z"); // 22:00 Madrid
  const out = nextSendTime(eveningBefore);
  assert.equal(localHM(out), "09:00");
  assert.equal(localDate(out), "2026-03-29");
});

test("rolling over the autumn fall-back night still lands on 09:00", () => {
  // 2026-10-25 is 25 hours long; a flat 24h would undershoot to 08:00.
  const eveningBefore = Date.parse("2026-10-24T20:00:00.000Z"); // 22:00 Madrid
  const out = nextSendTime(eveningBefore);
  assert.equal(localHM(out), "09:00");
  assert.equal(localDate(out), "2026-10-25");
});

test("nextSendTime is idempotent — applying it twice changes nothing", () => {
  for (const t of [
    Date.parse("2026-08-03T00:00:00.000Z"),
    Date.parse("2026-08-03T19:30:00.000Z"),
    SUMMER_0900,
    WINTER_0900,
  ]) {
    const once = nextSendTime(t);
    assert.equal(nextSendTime(once), once, `not idempotent at ${new Date(t).toISOString()}`);
    assert.equal(isWithinWindow(once), true, "settled on an out-of-window instant");
  }
});

test("a custom window is honoured, so the rule is not hard-wired to Madrid", () => {
  const opts = { timeZone: "UTC", openHour: 6, closeHour: 10 };
  const fiveUtc = Date.parse("2026-08-03T05:00:00.000Z");
  assert.equal(isWithinWindow(fiveUtc, opts), false);
  assert.equal(new Date(nextSendTime(fiveUtc, opts)).toISOString(), "2026-08-03T06:00:00.000Z");
  const elevenUtc = Date.parse("2026-08-03T11:00:00.000Z");
  assert.equal(new Date(nextSendTime(elevenUtc, opts)).toISOString(), "2026-08-04T06:00:00.000Z");
});
