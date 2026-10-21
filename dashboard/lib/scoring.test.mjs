// Minimal sanity assertions for the scoring math (per the brief's testing
// non-goal: one or two assertions, no test framework). Run with:
//   node --test lib/scoring.test.mjs
// This imports the compiled-at-runtime TS via a tiny inline re-implementation
// check is avoided — instead we exercise the real module through Node's
// experimental TS support (Node 22+ / 25 strips types natively).
import test from "node:test";
import assert from "node:assert/strict";
import { score, passesFilter } from "./scoring.ts";

const weights = {
  rating: 1.0,
  reviews: 0.8,
  website: 0.5,
  ecommerce: 1.0,
  distance: 0.3,
  minRating: 4.0,
  minReviews: 20,
};

const baseFlorist = {
  id: "1",
  city_id: "city-1",
  place_id: "p1",
  name: "Test Florist",
  address: null,
  lat: 42.35,
  lng: -71.06,
  rating: 4.6,
  review_count: 120,
  distance_km_from_center: 2,
  phone_maps: null,
  website_url: "https://example.com",
  has_website: true,
  is_ecommerce: true,
  ecommerce_signals: null,
  email: null,
  phone_web: null,
  owner_name: null,
  enrichment_notes: null,
  drafted_email: null,
  ingested_at: new Date().toISOString(),
};

test("score() matches the hand-computed value for a fully-populated florist", () => {
  const expected =
    1.0 * (4.6 - 3.0) +
    0.8 * Math.log10(121) +
    0.5 * 1 +
    1.0 * 1 -
    0.3 * 2;
  assert.equal(score(baseFlorist, weights), expected);
});

test("score() and passesFilter() never produce NaN or throw for a florist with all-null nullable fields", () => {
  const blankFlorist = {
    ...baseFlorist,
    rating: null,
    review_count: null,
    distance_km_from_center: null,
    lat: null,
    lng: null,
    is_ecommerce: null,
  };
  const result = score(blankFlorist, weights);
  assert.equal(Number.isNaN(result), false);
  assert.equal(passesFilter(blankFlorist, weights), false); // 0 rating < minRating 4.0
});
