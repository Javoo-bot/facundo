import { describe, expect, it } from "vitest";
import { isInWorkingSet, normalizeCountryCode, extractDeliveryCountry, type WorkingSetCriteria } from "../src/tags";

const noCriteria: WorkingSetCriteria = { activeOrderTags: [], activeOrderCountries: [], runAllOrders: false };

describe("isInWorkingSet", () => {
  it("empty criteria means NO order is worked (safe default, not 'everything')", () => {
    expect(isInWorkingSet({ tags: "fulfillment-tookan", deliveryCountry: "ES" }, noCriteria)).toBe(false);
    expect(isInWorkingSet({ tags: null, deliveryCountry: null }, noCriteria)).toBe(false);
  });

  it("run_all_orders short-circuits to true for still-live orders", () => {
    expect(isInWorkingSet({ tags: null, deliveryCountry: null }, { ...noCriteria, runAllOrders: true })).toBe(true);
    expect(
      isInWorkingSet({ tags: "unrelated", deliveryCountry: "DE" }, { activeOrderTags: ["other"], activeOrderCountries: ["FR"], runAllOrders: true })
    ).toBe(true);
  });

  it("explicit manual picks are always included", () => {
    expect(isInWorkingSet({ tags: null, deliveryCountry: null, deliveryAt: "2020-01-01T00:00:00Z", hasExplicitPick: true }, noCriteria)).toBe(true);
  });

  it("automatic country/tag/run-all criteria do not include past-delivery orders", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    const past = "2026-09-14T11:59:59Z";
    expect(isInWorkingSet({ tags: "priority", deliveryCountry: "FR", deliveryAt: past }, { activeOrderTags: ["priority"], activeOrderCountries: [], runAllOrders: false }, now)).toBe(false);
    expect(isInWorkingSet({ tags: null, deliveryCountry: "FR", deliveryAt: past }, { activeOrderTags: [], activeOrderCountries: ["FR"], runAllOrders: false }, now)).toBe(false);
    expect(isInWorkingSet({ tags: null, deliveryCountry: null, deliveryAt: past }, { ...noCriteria, runAllOrders: true }, now)).toBe(false);
  });

  it("country-only match, case-insensitive", () => {
    const criteria: WorkingSetCriteria = { activeOrderTags: [], activeOrderCountries: ["ES", "FR"], runAllOrders: false };
    expect(isInWorkingSet({ tags: null, deliveryCountry: "ES" }, criteria)).toBe(true);
    expect(isInWorkingSet({ tags: null, deliveryCountry: "es" }, criteria)).toBe(true);
    expect(isInWorkingSet({ tags: null, deliveryCountry: "DE" }, criteria)).toBe(false);
    expect(isInWorkingSet({ tags: null, deliveryCountry: null }, criteria)).toBe(false);
  });

  it("tag-only match", () => {
    const criteria: WorkingSetCriteria = { activeOrderTags: ["fulfillment-tookan"], activeOrderCountries: [], runAllOrders: false };
    expect(isInWorkingSet({ tags: "fulfillment-tookan, priority", deliveryCountry: null }, criteria)).toBe(true);
    expect(isInWorkingSet({ tags: "priority", deliveryCountry: "ES" }, criteria)).toBe(false);
  });

  it("either criterion alone is enough (OR, not AND)", () => {
    const criteria: WorkingSetCriteria = { activeOrderTags: ["priority"], activeOrderCountries: ["ES"], runAllOrders: false };
    expect(isInWorkingSet({ tags: "priority", deliveryCountry: "DE" }, criteria)).toBe(true);
    expect(isInWorkingSet({ tags: "other", deliveryCountry: "ES" }, criteria)).toBe(true);
    expect(isInWorkingSet({ tags: "other", deliveryCountry: "DE" }, criteria)).toBe(false);
  });
});

describe("normalizeCountryCode", () => {
  it("trims + upper-cases; blank/null/undefined -> null", () => {
    expect(normalizeCountryCode("  es ")).toBe("ES");
    expect(normalizeCountryCode("")).toBe(null);
    expect(normalizeCountryCode(null)).toBe(null);
    expect(normalizeCountryCode(undefined)).toBe(null);
  });
});

describe("extractDeliveryCountry", () => {
  it("reads + normalizes delivery_address.country; missing/non-string -> null", () => {
    expect(extractDeliveryCountry({ country: "es" })).toBe("ES");
    expect(extractDeliveryCountry({ country: "  FR " })).toBe("FR");
    expect(extractDeliveryCountry({})).toBe(null);
    expect(extractDeliveryCountry(null)).toBe(null);
    expect(extractDeliveryCountry({ country: 123 })).toBe(null);
  });
});
