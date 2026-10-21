import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm, formatKm } from "./geo.ts";

test("distance between two known points (Girona → Barcelona ~ 84km)", () => {
  const km = haversineKm(41.9794, 2.8214, 41.3874, 2.1686);
  assert.ok(km > 80 && km < 90, `expected ~84km, got ${km}`);
});

test("zero distance for identical points", () => {
  assert.equal(haversineKm(41.98, 2.82, 41.98, 2.82), 0);
});

test("null / non-finite coordinates yield null, never NaN", () => {
  assert.equal(haversineKm(null, 2.82, 41.3, 2.1), null);
  assert.equal(haversineKm(41.9, null, 41.3, 2.1), null);
  assert.equal(haversineKm(41.9, 2.8, undefined, 2.1), null);
  assert.equal(haversineKm(NaN, 2.8, 41.3, 2.1), null);
});

test("result is rounded to one decimal", () => {
  const km = haversineKm(41.9794, 2.8214, 41.9894, 2.8314);
  assert.equal(Math.round(km * 10) / 10, km);
});

test("formatKm: one decimal under 10km, whole km at or above", () => {
  assert.equal(formatKm(0), "0.0 km");
  assert.equal(formatKm(1.24), "1.2 km");
  assert.equal(formatKm(9.99), "10.0 km"); // toFixed rounds; still the <10 branch
  assert.equal(formatKm(10), "10 km");
  assert.equal(formatKm(84.3), "84 km");
});

test("formatKm: null in, null out — the caller decides what to render", () => {
  assert.equal(formatKm(null), null);
  assert.equal(formatKm(undefined), null);
  assert.equal(formatKm(NaN), null);
});
