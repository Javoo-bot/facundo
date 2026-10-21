import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBatchCities } from "./ingestBatch.ts";

test("accepts a valid cities array with shared radius/limit", () => {
  const r = parseBatchCities({ cities: [{ country: "ES", city: "Girona" }], radius: 10, limit: 40 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.cities, [{ country: "ES", city: "Girona" }]);
  assert.equal(r.value.radius, 10);
  assert.equal(r.value.limit, 40);
  assert.equal(r.value.resetExisting, false);
});

test("dedups cities case-insensitively", () => {
  const r = parseBatchCities({
    cities: [{ country: "ES", city: "Girona" }, { country: "es", city: "girona" }],
    radius: 10, limit: 40,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.cities.length, 1);
});

test("rejects empty or oversized lists", () => {
  assert.equal(parseBatchCities({ cities: [], radius: 10, limit: 40 }).ok, false);
  const many = Array.from({ length: 51 }, (_, i) => ({ country: "US", city: `C${i}` }));
  assert.equal(parseBatchCities({ cities: many, radius: 10, limit: 40 }).ok, false);
});

test("rejects out-of-range radius/limit", () => {
  assert.equal(parseBatchCities({ cities: [{ country: "US", city: "Boston" }], radius: 999, limit: 40 }).ok, false);
  assert.equal(parseBatchCities({ cities: [{ country: "US", city: "Boston" }], radius: 10, limit: 9999 }).ok, false);
});

test("rejects malformed entries", () => {
  assert.equal(parseBatchCities({ cities: [{ country: "", city: "Boston" }], radius: 10, limit: 40 }).ok, false);
});
