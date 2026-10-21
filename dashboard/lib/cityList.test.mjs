import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCityList } from "./cityList.ts";

test("parses one city per line, splitting on the first comma", () => {
  const r = parseCityList("ES, Barcelona\nUS, Boston");
  assert.deepEqual(r.cities, [
    { country: "ES", city: "Barcelona" },
    { country: "US", city: "Boston" },
  ]);
  assert.equal(r.errors.length, 0);
});

test("splits only on the first comma (city may contain commas)", () => {
  const r = parseCityList("US, Washington, D.C.");
  assert.deepEqual(r.cities, [{ country: "US", city: "Washington, D.C." }]);
});

test("skips blank lines; reports lines with no comma", () => {
  const r = parseCityList("ES, Girona\n\n   \nMadrid");
  assert.deepEqual(r.cities, [{ country: "ES", city: "Girona" }]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, "Madrid");
});

test("reports a line missing country or city", () => {
  const r = parseCityList("ES,\n, Boston");
  assert.equal(r.cities.length, 0);
  assert.equal(r.errors.length, 2);
});

test("dedups case-insensitively, keeping first occurrence", () => {
  const r = parseCityList("ES, Barcelona\nes, barcelona\nES, Girona");
  assert.deepEqual(r.cities, [
    { country: "ES", city: "Barcelona" },
    { country: "ES", city: "Girona" },
  ]);
});
