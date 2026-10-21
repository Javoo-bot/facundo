import test from "node:test";
import assert from "node:assert/strict";
import { hasActiveTag, splitOrderTags, isInWorkingSet, normalizeCountryCode, extractDeliveryCountry } from "./orderTags.ts";

test("hasActiveTag: empty active set passes every order (no filtering, incl. null tags)", () => {
  assert.equal(hasActiveTag("fulfillment-tookan, new-customer", []), true);
  assert.equal(hasActiveTag(null, []), true);
  assert.equal(hasActiveTag("", []), true);
});

test("hasActiveTag: matches one of the active tags", () => {
  assert.equal(hasActiveTag("24 July 2026, fulfillment-tookan, new-customer", ["fulfillment-tookan"]), true);
  assert.equal(hasActiveTag("fulfillment-tookan", ["fulfillment-tookan", "priority"]), true);
});

test("hasActiveTag: no intersection fails", () => {
  assert.equal(hasActiveTag("24 July 2026, new-customer", ["fulfillment-tookan"]), false);
});

test("hasActiveTag: null/empty order tags fail against a non-empty active set", () => {
  assert.equal(hasActiveTag(null, ["fulfillment-tookan"]), false);
  assert.equal(hasActiveTag("", ["fulfillment-tookan"]), false);
});

test("hasActiveTag: case-insensitive and whitespace-tolerant on both sides", () => {
  assert.equal(hasActiveTag("  Fulfillment-Tookan  ,new-customer", ["fulfillment-tookan"]), true);
  assert.equal(hasActiveTag("fulfillment-tookan", ["  FULFILLMENT-TOOKAN  "]), true);
});

test("hasActiveTag: an active set of only blank entries behaves like no filter", () => {
  assert.equal(hasActiveTag(null, ["  ", ""]), true);
  assert.equal(hasActiveTag("anything", ["  ", ""]), true);
});

test("splitOrderTags: splits, trims, drops empties; null → []", () => {
  assert.deepEqual(splitOrderTags("24 July 2026, fulfillment-tookan, new-customer"), ["24 July 2026", "fulfillment-tookan", "new-customer"]);
  assert.deepEqual(splitOrderTags(null), []);
  assert.deepEqual(splitOrderTags(""), []);
  assert.deepEqual(splitOrderTags("a,,b"), ["a", "b"]);
});

// ---- isInWorkingSet ----

const noCriteria = { activeOrderTags: [], activeOrderCountries: [], runAllOrders: false };

test("isInWorkingSet: empty criteria means NO order is worked (safe default, not 'everything')", () => {
  assert.equal(isInWorkingSet({ tags: "fulfillment-tookan", deliveryCountry: "ES" }, noCriteria), false);
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: null }, noCriteria), false);
});

test("isInWorkingSet: run_all_orders short-circuits to true for still-live orders", () => {
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: null }, { ...noCriteria, runAllOrders: true }), true);
  assert.equal(
    isInWorkingSet({ tags: "unrelated", deliveryCountry: "DE" }, { activeOrderTags: ["other"], activeOrderCountries: ["FR"], runAllOrders: true }),
    true
  );
});

test("isInWorkingSet: explicit manual picks are always included", () => {
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: null, deliveryAt: "2020-01-01T00:00:00Z", hasExplicitPick: true }, noCriteria), true);
});

test("isInWorkingSet: automatic country/tag/run-all criteria do not include past-delivery orders", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  const past = "2026-09-14T11:59:59Z";
  assert.equal(isInWorkingSet({ tags: "priority", deliveryCountry: "FR", deliveryAt: past }, { activeOrderTags: ["priority"], activeOrderCountries: [], runAllOrders: false }, now), false);
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: "FR", deliveryAt: past }, { activeOrderTags: [], activeOrderCountries: ["FR"], runAllOrders: false }, now), false);
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: null, deliveryAt: past }, { ...noCriteria, runAllOrders: true }, now), false);
});

test("isInWorkingSet: country-only match", () => {
  const criteria = { activeOrderTags: [], activeOrderCountries: ["ES", "FR"], runAllOrders: false };
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: "ES" }, criteria), true);
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: "es" }, criteria), true); // case-insensitive
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: "DE" }, criteria), false);
  assert.equal(isInWorkingSet({ tags: null, deliveryCountry: null }, criteria), false);
});

test("isInWorkingSet: tag-only match", () => {
  const criteria = { activeOrderTags: ["fulfillment-tookan"], activeOrderCountries: [], runAllOrders: false };
  assert.equal(isInWorkingSet({ tags: "fulfillment-tookan, priority", deliveryCountry: null }, criteria), true);
  assert.equal(isInWorkingSet({ tags: "priority", deliveryCountry: "ES" }, criteria), false);
});

test("isInWorkingSet: either criterion alone is enough (OR, not AND)", () => {
  const criteria = { activeOrderTags: ["priority"], activeOrderCountries: ["ES"], runAllOrders: false };
  assert.equal(isInWorkingSet({ tags: "priority", deliveryCountry: "DE" }, criteria), true); // tag matches, country doesn't
  assert.equal(isInWorkingSet({ tags: "other", deliveryCountry: "ES" }, criteria), true); // country matches, tag doesn't
  assert.equal(isInWorkingSet({ tags: "other", deliveryCountry: "DE" }, criteria), false); // neither
});

test("isInWorkingSet: an active set of only blank tag entries plus an empty country list stays the safe default", () => {
  const criteria = { activeOrderTags: ["  ", ""], activeOrderCountries: [], runAllOrders: false };
  assert.equal(isInWorkingSet({ tags: "anything", deliveryCountry: "ES" }, criteria), false);
});

test("normalizeCountryCode: trims + upper-cases; blank/null → null", () => {
  assert.equal(normalizeCountryCode("  es "), "ES");
  assert.equal(normalizeCountryCode(""), null);
  assert.equal(normalizeCountryCode(null), null);
  assert.equal(normalizeCountryCode(undefined), null);
});

test("extractDeliveryCountry: reads + normalizes delivery_address.country; missing/non-string → null", () => {
  assert.equal(extractDeliveryCountry({ country: "es" }), "ES");
  assert.equal(extractDeliveryCountry({ country: "  FR " }), "FR");
  assert.equal(extractDeliveryCountry({}), null);
  assert.equal(extractDeliveryCountry(null), null);
  assert.equal(extractDeliveryCountry({ country: 123 }), null);
});
