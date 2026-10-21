// src/match.ts is a GENERATED, byte-identical copy of dashboard/lib/match.ts
// (see dashboard/scripts/sync-match.mjs). Its behavior is covered in full by
// dashboard/lib/match.test.mjs — 56 tests over the hard filters, the distance
// rings, the within-ring score, the dedupes, and MatchConfig parsing.
//
// Duplicating that suite here is what caused the original problem: two
// hand-maintained copies drifted three ways (the performance term, the capacity
// filter, and the null-radius/null-tier guards) while both test suites passed,
// because each tested its own copy's behavior.
//
// So this file asserts only what the dashboard's suite CANNOT: that the copy the
// worker actually bundles is the same bytes, and that it loads and ranks inside
// the worker's own toolchain.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { matchFlorists, passesHardFilter, DEFAULT_MATCH_CONFIG, evaluateCandidatePool } from "../src/match";

const order = { delivery_lat: 41.98, delivery_lng: 2.82, delivery_at: null };

describe("the generated matcher", () => {
  it("is byte-identical to the canonical dashboard/lib/match.ts", () => {
    // `.pathname` rather than node:url's fileURLToPath: this package compiles
    // against @cloudflare/workers-types, whose global URL is not assignable to
    // node's. decodeURIComponent restores any percent-encoded path segment.
    const read = (rel: string) => readFileSync(decodeURIComponent(new URL(rel, import.meta.url).pathname), "utf8");
    const generated = read("../src/match.ts");
    const canonical = read("../../dashboard/lib/match.ts");
    expect(generated, "out of date — run `npm run sync:match` from dashboard/").toBe(canonical);
  });

  it("loads and ranks under the worker's toolchain", () => {
    const near = {
      id: "near", lat: 41.99, lng: 2.82, rating: 4.6, review_count: 120,
      lifecycle_stage: "production", excluded_at: null, source: "existing",
      trust_tier: "1", delivery_radius_km: null, capacity_per_day: null,
    };
    const far = { ...near, id: "far", lat: 42.10 };
    expect(passesHardFilter(order, near)).toBe(true);
    expect(matchFlorists(order, [far, near]).map((c) => c.florist_id)).toEqual(["near", "far"]);
  });

  it("exposes the defaults the migration's column defaults mirror", () => {
    // supabase/migrations/2026-08-06-matching-config.sql writes these same
    // numbers as column defaults, so a settings row and an absent one behave
    // identically. If one side changes, this is where it should hurt.
    expect(DEFAULT_MATCH_CONFIG.ringEdgesKm).toEqual([5, 10, 20]);
    expect(DEFAULT_MATCH_CONFIG.topN).toBe(3);
    expect(DEFAULT_MATCH_CONFIG.requireTrustTier).toBe(true);
    expect(DEFAULT_MATCH_CONFIG.weights).toEqual({
      distance: 0.25, onboarded: 3.0, emailable: 1.5,
      quality: 1.0, source: 1.2, tier: 1.0, performance: 0.4,
    });
  });
});

describe("evaluateCandidatePool", () => {
  const near = { lat: 41.98, lng: 2.82 }; // ~0km from `order`'s delivery point
  const far = { lat: 40.4, lng: -3.7 }; // Madrid — ~500km from Girona

  it("no_candidates when the pool is empty", () => {
    expect(evaluateCandidatePool([], order, 5)).toBe("no_candidates");
  });

  it("missing_delivery_coordinates when the order has no delivery lat/lng but the pool isn't empty", () => {
    expect(evaluateCandidatePool([near], { delivery_lat: null, delivery_lng: null }, 5)).toBe("missing_delivery_coordinates");
  });

  it("ok when at least one florist is within radius", () => {
    expect(evaluateCandidatePool([far, near], order, 5)).toBe("ok");
  });

  it("no_candidates_within_radius when every florist is farther than radius (or has no coordinates)", () => {
    expect(evaluateCandidatePool([far], order, 5)).toBe("no_candidates_within_radius");
    expect(evaluateCandidatePool([{ lat: null, lng: null }], order, 5)).toBe("no_candidates_within_radius");
  });
});
