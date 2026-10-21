import test from "node:test";
import assert from "node:assert/strict";
import { greetingKey, greetingKeyForHour } from "./floristGreeting.ts";

test("every hour of the day maps to a bucket", () => {
  for (let h = 0; h <= 23; h++) {
    assert.ok(["morning", "afternoon", "evening", "night"].includes(greetingKeyForHour(h)), `hour ${h}`);
  }
});

test("bucket boundaries land on the right side", () => {
  assert.equal(greetingKeyForHour(4), "night");
  assert.equal(greetingKeyForHour(5), "morning");
  assert.equal(greetingKeyForHour(11), "morning");
  assert.equal(greetingKeyForHour(12), "afternoon");
  assert.equal(greetingKeyForHour(17), "afternoon");
  assert.equal(greetingKeyForHour(18), "evening");
  assert.equal(greetingKeyForHour(21), "evening");
  assert.equal(greetingKeyForHour(22), "night");
  assert.equal(greetingKeyForHour(0), "night");
});

test("uses the shop's timezone, not the server's", () => {
  // 2026-08-05T08:00:00Z — 10:00 in Madrid (CEST), 17:00 in Tokyo, 04:00 in New York.
  const ms = Date.parse("2026-08-05T08:00:00Z");
  assert.equal(greetingKey("Europe/Madrid", ms), "morning");
  assert.equal(greetingKey("Asia/Tokyo", ms), "afternoon");
  assert.equal(greetingKey("America/New_York", ms), "night");
});

test("respects daylight saving rather than a fixed offset", () => {
  // 06:30 UTC is 08:30 Madrid in August (CEST, +2) but 07:30 in January (CET, +1).
  // Both are 'morning', so pick an instant where the shift crosses a boundary:
  // 03:30 UTC is 05:30 CEST (morning) and 04:30 CET (night).
  assert.equal(greetingKey("Europe/Madrid", Date.parse("2026-08-05T03:30:00Z")), "morning");
  assert.equal(greetingKey("Europe/Madrid", Date.parse("2026-01-05T03:30:00Z")), "night");
});

test("returns null when there is no timezone", () => {
  assert.equal(greetingKey(null, Date.parse("2026-08-05T08:00:00Z")), null);
});

test("returns null for a zone Intl doesn't know, rather than throwing", () => {
  assert.equal(greetingKey("Mars/Olympus_Mons", Date.parse("2026-08-05T08:00:00Z")), null);
});

test("returns null for an unusable instant", () => {
  assert.equal(greetingKey("Europe/Madrid", Number.NaN), null);
});
