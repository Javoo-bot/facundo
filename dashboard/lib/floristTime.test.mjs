import test from "node:test";
import assert from "node:assert/strict";
import { floristTimeZone, formatOfferDeadline } from "./floristTime.ts";

// Coordinates a country -> timezone map gets WRONG. These are the reason the
// deadline goes through a real lat/lng lookup rather than the shop's country.
test("floristTimeZone resolves the zones a country map would get wrong", () => {
  assert.equal(floristTimeZone(41.98, 2.82), "Europe/Madrid"); // Girona
  assert.equal(floristTimeZone(28.29, -16.62), "Atlantic/Canary"); // Tenerife — also ES
  assert.equal(floristTimeZone(38.72, -9.14), "Europe/Lisbon"); // Lisbon
  assert.equal(floristTimeZone(37.74, -25.67), "Atlantic/Azores"); // Ponta Delgada — also PT
  assert.equal(floristTimeZone(-23.55, -46.63), "America/Sao_Paulo");
  assert.equal(floristTimeZone(-3.12, -60.02), "America/Manaus"); // also BR, one hour behind
});

test("floristTimeZone returns null (never throws) for missing or impossible coordinates", () => {
  assert.equal(floristTimeZone(null, null), null);
  assert.equal(floristTimeZone(undefined, undefined), null);
  assert.equal(floristTimeZone(41.98, null), null);
  assert.equal(floristTimeZone(NaN, 2.82), null);
  assert.equal(floristTimeZone(91, 2.82), null);
  assert.equal(floristTimeZone(41.98, 181), null);
  assert.equal(floristTimeZone("41.98", "2.82"), null);
});

// 12:00 UTC on 6 Aug 2026 — summer, so Madrid is UTC+2 and Sao_Paulo UTC-3.
const NOW = Date.parse("2026-08-06T12:00:00.000Z");

test("formatOfferDeadline renders a same-day deadline as 24h wall-clock in the florist's zone", () => {
  const inTwoHours = new Date(NOW + 2 * 3600_000).toISOString(); // 14:00 UTC
  assert.equal(formatOfferDeadline("en", inTwoHours, "Europe/Madrid", NOW), "16:00");
  assert.equal(formatOfferDeadline("pt", inTwoHours, "Europe/Lisbon", NOW), "15:00");
  assert.equal(formatOfferDeadline("pt", inTwoHours, "Atlantic/Azores", NOW), "14:00");
  assert.equal(formatOfferDeadline("pt", inTwoHours, "America/Sao_Paulo", NOW), "11:00");
});

test("formatOfferDeadline never renders 12-hour AM/PM, including for en", () => {
  const evening = Date.parse("2026-08-06T18:30:00.000Z"); // 20:30 in Madrid
  const out = formatOfferDeadline("en", new Date(evening).toISOString(), "Europe/Madrid", NOW);
  assert.equal(out, "20:30");
  assert.ok(!/AM|PM/i.test(out));
});

test("formatOfferDeadline carries the date when the deadline lands on a different local day", () => {
  // 22:00 UTC = 00:00 next day in Madrid. A bare "00:00" would be ambiguous.
  const pastMidnight = Date.parse("2026-08-06T22:00:00.000Z");
  const out = formatOfferDeadline("en", new Date(pastMidnight).toISOString(), "Europe/Madrid", NOW);
  assert.match(out, /7 Aug/);
  assert.match(out, /00:00/);
});

test("formatOfferDeadline is zone-aware about what 'same day' means", () => {
  // 01:00 UTC on 7 Aug is still 6 Aug (22:00) in Sao Paulo but already 7 Aug
  // (03:00) in Madrid — the same instant, a different calendar day each side.
  const iso = new Date(Date.parse("2026-08-07T01:00:00.000Z")).toISOString();
  assert.equal(formatOfferDeadline("pt", iso, "America/Sao_Paulo", NOW), "22:00");
  assert.match(formatOfferDeadline("en", iso, "Europe/Madrid", NOW), /7 Aug/);
});

test("formatOfferDeadline returns null when there is no timezone — the caller falls back to the countdown", () => {
  const inTwoHours = new Date(NOW + 2 * 3600_000).toISOString();
  assert.equal(formatOfferDeadline("en", inTwoHours, null, NOW), null);
});

test("formatOfferDeadline returns null for a missing or unparseable expiry", () => {
  assert.equal(formatOfferDeadline("en", null, "Europe/Madrid", NOW), null);
  assert.equal(formatOfferDeadline("en", undefined, "Europe/Madrid", NOW), null);
  assert.equal(formatOfferDeadline("en", "not-a-date", "Europe/Madrid", NOW), null);
});

test("formatOfferDeadline returns null once the deadline has passed (never 'answer before 14:30' at 15:10)", () => {
  assert.equal(formatOfferDeadline("en", new Date(NOW - 1000).toISOString(), "Europe/Madrid", NOW), null);
  assert.equal(formatOfferDeadline("en", new Date(NOW).toISOString(), "Europe/Madrid", NOW), null); // exactly now
});

test("formatOfferDeadline returns null (never throws) for a zone Intl doesn't know", () => {
  const inTwoHours = new Date(NOW + 2 * 3600_000).toISOString();
  assert.equal(formatOfferDeadline("en", inTwoHours, "Mars/Olympus_Mons", NOW), null);
});
