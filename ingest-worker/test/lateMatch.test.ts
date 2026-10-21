import { describe, expect, it } from "vitest";
import { shouldLateMatch } from "../src/lateMatch";
import type { WorkingSetCriteria } from "../src/tags";

const noCriteria: WorkingSetCriteria = { activeOrderTags: [], activeOrderCountries: [], runAllOrders: false };
const tagCriteria: WorkingSetCriteria = { activeOrderTags: ["fulfillment-tookan"], activeOrderCountries: [], runAllOrders: false };
const countryCriteria: WorkingSetCriteria = { activeOrderTags: [], activeOrderCountries: ["ES"], runAllOrders: false };

// The late-tag path re-matches an order ONLY when it's still parked at
// "received" AND now qualifies for the working set. Anything already worked,
// or still out of the working set, must be left alone.
describe("shouldLateMatch", () => {
  it("matches a parked order that now carries an active tag", () => {
    expect(shouldLateMatch("received", "fulfillment-tookan, 27 July 2026", null, tagCriteria)).toBe(true);
  });

  it("does not match a parked order that still lacks any active tag or country", () => {
    expect(shouldLateMatch("received", "27 July 2026", null, tagCriteria)).toBe(false);
  });

  it("matches on delivery country alone, independent of tags", () => {
    expect(shouldLateMatch("received", null, "ES", countryCriteria)).toBe(true);
    expect(shouldLateMatch("received", null, "DE", countryCriteria)).toBe(false);
  });

  it("does not match ANY parked order when no working-set criteria is configured (safe default)", () => {
    expect(shouldLateMatch("received", null, null, noCriteria)).toBe(false);
    expect(shouldLateMatch("received", "fulfillment-tookan", "ES", noCriteria)).toBe(false);
  });

  it("matches every parked order when run_all_orders is on, regardless of tags/country", () => {
    expect(shouldLateMatch("received", null, null, { ...noCriteria, runAllOrders: true })).toBe(true);
  });

  it("never re-matches an order that has already moved past 'received'", () => {
    for (const status of ["matched", "escalated", "accepted", "delivered", "paid", "closed", "cancelled"]) {
      expect(shouldLateMatch(status, "fulfillment-tookan", "ES", tagCriteria)).toBe(false);
    }
  });

  it("is case- and whitespace-insensitive on the tag match", () => {
    expect(shouldLateMatch("received", "  Fulfillment-Tookan  ", null, tagCriteria)).toBe(true);
  });
});
