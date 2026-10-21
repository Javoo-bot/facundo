// Minimal sanity assertions for the stats aggregation math (per the brief's
// testing non-goal: a few assertions, no test framework). Run with:
//   node --test lib/stats.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCityStats,
  rollupCityStats,
  groupCitiesByCountryAndRegion,
  aggregateFlorists,
  computeGlobalSummary,
  OTHER_REGION,
} from "./stats.ts";

function makeFlorist(overrides = {}) {
  return {
    id: "f1",
    city_id: "city-1",
    place_id: "p1",
    name: "Test Florist",
    address: null,
    lat: 42.35,
    lng: -71.06,
    rating: 4.6,
    review_count: 120,
    distance_km_from_center: 2,
    phone_maps: "555-1234",
    website_url: "https://example.com",
    has_website: true,
    is_ecommerce: true,
    ecommerce_signals: null,
    email: "owner@example.com",
    phone_web: null,
    owner_name: null,
    enrichment_notes: null,
    drafted_email: "Hi there...",
    ingested_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeCity(overrides = {}) {
  return {
    id: "city-1",
    country: "US",
    city: "Boston",
    center_lat: 42.36,
    center_lng: -71.06,
    radius_km: 10,
    region: "Massachusetts",
    ingested_at: new Date().toISOString(),
    ...overrides,
  };
}

test("computeCityStats() for a normal city with mixed data", () => {
  const florists = [
    makeFlorist({ id: "1", rating: 4.6, review_count: 120, is_ecommerce: true }),
    makeFlorist({
      id: "2",
      rating: 4.0,
      review_count: 30,
      is_ecommerce: false,
      email: null,
      phone_maps: null,
      phone_web: null,
      drafted_email: null,
    }),
  ];
  const stats = computeCityStats(florists);
  assert.equal(stats.floristCount, 2);
  assert.equal(stats.avgRating, 4.3);
  assert.equal(stats.totalReviews, 150);
  assert.equal(stats.topTargets, 1); // only the 4.6-rated florist qualifies (>= 4.5)
  assert.equal(stats.pctEcommerce, 50);
  assert.equal(stats.pctReachable, 50); // florist "2" has no email/phone
  assert.equal(stats.emailsFound, 1);
  assert.equal(stats.draftsReady, 1);
  assert.equal(stats.emailsSent, null);
  assert.equal(stats.replies, null);
  assert.equal(stats.replyRate, null);
});

test("computeCityStats() for an empty city never divides by zero or NaNs", () => {
  const stats = computeCityStats([]);
  assert.equal(stats.floristCount, 0);
  assert.equal(stats.avgRating, null);
  assert.equal(stats.totalReviews, 0);
  assert.equal(stats.topTargets, 0);
  assert.equal(stats.pctEcommerce, null);
  assert.equal(stats.pctReachable, null);
  assert.equal(Number.isNaN(stats.totalReviews), false);
});

test("computeCityStats() handles a florist with every nullable field null", () => {
  const blank = makeFlorist({
    rating: null,
    review_count: null,
    is_ecommerce: null,
    email: null,
    phone_maps: null,
    phone_web: null,
    drafted_email: null,
  });
  const stats = computeCityStats([blank]);
  assert.equal(stats.floristCount, 1);
  assert.equal(stats.avgRating, null); // no rated florists — not defaulted to 0
  assert.equal(stats.totalReviews, 0);
  assert.equal(stats.topTargets, 0);
  assert.equal(stats.pctEcommerce, 0);
  assert.equal(stats.pctReachable, 0);
  assert.equal(stats.emailsFound, 0);
  assert.equal(stats.draftsReady, 0);
  assert.equal(Number.isNaN(stats.pctEcommerce), false);
});

test("rollupCityStats() over an empty group (zero total florists) never NaNs", () => {
  const rollup = rollupCityStats([computeCityStats([]), computeCityStats([])]);
  assert.equal(rollup.floristCount, 0);
  assert.equal(rollup.avgRating, null);
  assert.equal(rollup.pctEcommerce, null);
  assert.equal(rollup.pctReachable, null);
});

test("rollupCityStats() weights avgRating by floristCount, not average-of-averages", () => {
  // City A: 1 florist rated 5.0. City B: 3 florists rated 3.0.
  const cityA = computeCityStats([makeFlorist({ id: "a1", rating: 5.0 })]);
  const cityB = computeCityStats([
    makeFlorist({ id: "b1", rating: 3.0 }),
    makeFlorist({ id: "b2", rating: 3.0 }),
    makeFlorist({ id: "b3", rating: 3.0 }),
  ]);
  const rollup = rollupCityStats([cityA, cityB]);
  // Weighted: (5.0*1 + 3.0*3) / 4 = 3.5. A naive average-of-averages would
  // give (5.0 + 3.0) / 2 = 4.0.
  assert.equal(rollup.avgRating, 3.5);
  assert.equal(rollup.floristCount, 4);
});

test("groupCitiesByCountryAndRegion() groups a null region under 'Other'", () => {
  const cities = [
    makeCity({ id: "c1", country: "US", region: "Massachusetts", city: "Boston" }),
    makeCity({ id: "c2", country: "US", region: null, city: "Nowhereville" }),
    makeCity({ id: "c3", country: "US", region: "", city: "Emptyregionton" }),
  ];
  const florists = [
    makeFlorist({ id: "f1", city_id: "c1" }),
    makeFlorist({ id: "f2", city_id: "c2" }),
  ];
  const groups = groupCitiesByCountryAndRegion(cities, florists);
  assert.equal(groups.length, 1);
  const us = groups[0];
  assert.equal(us.country, "US");
  const otherRegion = us.regions.find((r) => r.region === OTHER_REGION);
  assert.ok(otherRegion, "expected an 'Other' region group");
  // Both the null-region and empty-string-region cities land in "Other".
  assert.equal(otherRegion.cities.length, 2);
  const massRegion = us.regions.find((r) => r.region === "Massachusetts");
  assert.equal(massRegion.cities.length, 1);
  // Country rollup sums both regions' florists.
  assert.equal(us.stats.floristCount, 2);
});

test("computeGlobalSummary() counts distinct countries/regions/cities and excludes 'Other' from the region count", () => {
  const cities = [
    makeCity({ id: "c1", country: "US", region: "Massachusetts" }),
    makeCity({ id: "c2", country: "US", region: "California" }),
    makeCity({ id: "c3", country: "US", region: null }),
    makeCity({ id: "c4", country: "FR", region: "Île-de-France" }),
  ];
  const florists = [
    makeFlorist({ id: "f1", city_id: "c1", rating: 4.0 }),
    makeFlorist({ id: "f2", city_id: "c2", rating: 5.0 }),
  ];
  const summary = computeGlobalSummary(cities, aggregateFlorists(florists));
  assert.equal(summary.countries, 2);
  assert.equal(summary.regions, 3); // Massachusetts, California, Île-de-France — "Other" excluded
  assert.equal(summary.hasOtherRegion, true);
  assert.equal(summary.cities, 4);
  assert.equal(summary.totalFlorists, 2);
  assert.equal(summary.overallAvgRating, 4.5);
});

test("computeGlobalSummary() over zero cities/florists never NaNs", () => {
  const summary = computeGlobalSummary([], aggregateFlorists([]));
  assert.equal(summary.countries, 0);
  assert.equal(summary.regions, 0);
  assert.equal(summary.hasOtherRegion, false);
  assert.equal(summary.totalFlorists, 0);
  assert.equal(summary.overallAvgRating, null);
});

// The roster aggregates moved out of computeGlobalSummary so the home page can
// read them from the `florist_summary` view (one row) instead of pulling all
// 6,264 florists into the browser to count them. aggregateFlorists is the JS
// twin of that view — the two definitions must agree, so pin the definitions
// that are easy to get subtly wrong.
test("aggregateFlorists() counts reachable via email OR either phone, and never NaNs when empty", () => {
  assert.deepEqual(aggregateFlorists([]), {
    totalFlorists: 0,
    totalReachable: 0,
    totalEcommerce: 0,
    draftsReady: 0,
    overallAvgRating: null,
  });

  const rows = [
    makeFlorist({ id: "a", email: "a@x.com", phone_maps: null, phone_web: null }),
    makeFlorist({ id: "b", email: null, phone_maps: "+34 900", phone_web: null }),
    makeFlorist({ id: "c", email: null, phone_maps: null, phone_web: "+34 901" }),
    makeFlorist({ id: "d", email: null, phone_maps: null, phone_web: null }),
  ];
  assert.equal(aggregateFlorists(rows).totalReachable, 3);
  assert.equal(aggregateFlorists(rows).totalFlorists, 4);
});

test("aggregateFlorists() treats an EMPTY STRING contact as unreachable, not reachable", () => {
  // Load-bearing, and not hypothetical: 821 florists carry `phone_maps = ''`
  // today. This is truthiness, so '' is falsy — whereas SQL's `is not null` is
  // true for it. The `florist_summary` view (supabase/migrations/2026-08-11-
  // order-working-set.sql) therefore guards with `coalesce(col,'') <> ''` to
  // stay an exact twin of this function. A plain null-check there reported
  // 6,264 reachable against this function's 5,492.
  const rows = [
    makeFlorist({ id: "a", email: "", phone_maps: "", phone_web: "" }),
    makeFlorist({ id: "b", email: "", phone_maps: "+34 900", phone_web: "" }),
  ];
  assert.equal(aggregateFlorists(rows).totalReachable, 1);
});

test("aggregateFlorists() averages only rated florists, and is_ecommerce must be exactly true", () => {
  const rows = [
    makeFlorist({ id: "a", rating: 4.0, is_ecommerce: true, drafted_email: "hi" }),
    makeFlorist({ id: "b", rating: 5.0, is_ecommerce: null, drafted_email: null }),
    makeFlorist({ id: "c", rating: null, is_ecommerce: false, drafted_email: null }),
  ];
  const agg = aggregateFlorists(rows);
  assert.equal(agg.overallAvgRating, 4.5); // the unrated florist is excluded, not counted as 0
  assert.equal(agg.totalEcommerce, 1);     // null and false both fail
  assert.equal(agg.draftsReady, 1);
});
