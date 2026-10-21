// Order → florist matching. Run with:
//   node --test lib/match.test.mjs
//
// Covers the four things that decide who gets an offer: the hard filters, the
// distance rings, the within-ring score, and the two dedupes. See
// docs/superpowers/specs/2026-08-06-matching-rings-and-config-design.md.
import test from "node:test";
import assert from "node:assert/strict";
import {
  passesHardFilter,
  passesQualityFloor,
  matchFlorists,
  ringIndex,
  effectiveRadiusKm,
  capKm,
  DEFAULT_MATCH_CONFIG,
} from "./match.ts";

const order = { delivery_lat: 41.98, delivery_lng: 2.82, delivery_at: null };
const base = {
  id: "f", lat: 41.98, lng: 2.82, rating: 4.6, review_count: 120,
  lifecycle_stage: "production", excluded_at: null, source: "existing",
  trust_tier: "1", delivery_radius_km: 10, capacity_per_day: null,
};

/** A florist `km` due north of the delivery point. One degree of latitude is
 *  ~111.32km, so this lands within a few metres of the intended distance. */
const at = (km, extra = {}) => ({ ...base, lat: 41.98 + km / 111.32, lng: 2.82, ...extra });

/** DEFAULT_MATCH_CONFIG with `patch` merged over it (weights merged too). */
const cfg = (patch = {}) => ({
  ...DEFAULT_MATCH_CONFIG,
  ...patch,
  weights: { ...DEFAULT_MATCH_CONFIG.weights, ...(patch.weights ?? {}) },
});

// ---------------------------------------------------------------------------
// Hard filters — who must never receive this order at all.
// ---------------------------------------------------------------------------

test("passesHardFilter: production passes", () => {
  assert.equal(passesHardFilter(order, { ...base }), true);
});

test("passesHardFilter: engaged (non-onboarded, pre-production) passes", () => {
  assert.equal(passesHardFilter(order, { ...base, lifecycle_stage: "engaged" }), true);
});

test("passesHardFilter: lost is denied", () => {
  assert.equal(passesHardFilter(order, { ...base, lifecycle_stage: "lost" }), false);
});

test("passesHardFilter: excluded_at is denied regardless of stage", () => {
  assert.equal(passesHardFilter(order, { ...base, excluded_at: "2026-01-01" }), false);
  assert.equal(passesHardFilter(order, { ...base, lifecycle_stage: "engaged", excluded_at: "2026-01-01" }), false);
});

test("passesHardFilter: a florist with no trust tier can't be paid, so is denied by default", () => {
  // lib/payout.ts resolves the accept/delivery split from `trust_tiers` by this
  // code. No tier, no split, no way to pay them.
  assert.equal(passesHardFilter(order, { ...base, trust_tier: null }), false);
});

test("passesHardFilter: requireTrustTier:false lets untiered florists through (recruiting runs)", () => {
  const f = { ...base, trust_tier: null };
  assert.equal(passesHardFilter(order, f, "exclude", cfg({ requireTrustTier: false })), true);
});

test("passesHardFilter: a florist at capacity for the day is denied", () => {
  assert.equal(passesHardFilter(order, { ...base, capacity_per_day: 3, accepted_count_for_day: 3 }), false);
  assert.equal(passesHardFilter(order, { ...base, capacity_per_day: 3, accepted_count_for_day: 2 }), true);
  // No capacity limit set -> never rejected on this basis, regardless of load.
  assert.equal(passesHardFilter(order, { ...base, capacity_per_day: null, accepted_count_for_day: 999 }), true);
  // accepted_count_for_day absent -> defaults to 0, never crashes.
  assert.equal(passesHardFilter(order, { ...base, capacity_per_day: 1, accepted_count_for_day: undefined }), true);
});

// ---------------------------------------------------------------------------
// Distance: the cap, the florist's own radius, and the interaction.
// ---------------------------------------------------------------------------

test("capKm is the last ring edge", () => {
  assert.equal(capKm(DEFAULT_MATCH_CONFIG), 20);
  assert.equal(capKm(cfg({ ringEdgesKm: [3, 7] })), 7);
});

test("effectiveRadiusKm: a null radius means 'use the cap', not 'reject'", () => {
  // 5,816 of 5,829 florists had no radius on 2026-08-06 — this is the common case.
  assert.equal(effectiveRadiusKm({ ...base, delivery_radius_km: null }, DEFAULT_MATCH_CONFIG), 20);
});

test("effectiveRadiusKm: the cap floors a larger claim, and a smaller claim still wins", () => {
  assert.equal(effectiveRadiusKm({ ...base, delivery_radius_km: 50 }, DEFAULT_MATCH_CONFIG), 20);
  assert.equal(effectiveRadiusKm({ ...base, delivery_radius_km: 5 }, DEFAULT_MATCH_CONFIG), 5);
});

test("passesHardFilter: a null-radius florist is matchable inside the cap and denied beyond it", () => {
  assert.equal(passesHardFilter(order, at(15, { delivery_radius_km: null })), true);
  assert.equal(passesHardFilter(order, at(25, { delivery_radius_km: null })), false);
});

test("passesHardFilter: our cap beats a florist's inflated claim", () => {
  // The shop says it covers 50km. We say 20. A 25km order does not reach them.
  assert.equal(passesHardFilter(order, at(25, { delivery_radius_km: 50 })), false);
  assert.equal(passesHardFilter(order, at(18, { delivery_radius_km: 50 })), true);
});

test("passesHardFilter: a modest claim is still respected inside the cap", () => {
  assert.equal(passesHardFilter(order, at(7, { delivery_radius_km: 5 })), false);
  assert.equal(passesHardFilter(order, at(4, { delivery_radius_km: 5 })), true);
});

test("passesHardFilter: an unknown distance EXCLUDES rather than passing silently", () => {
  // Before rings, a null lat/lng meant every florist cleared the radius check and
  // scored distance-0 — an order we couldn't locate was offered to an arbitrary shop.
  assert.equal(passesHardFilter(order, { ...base, lat: null, lng: null }), false);
  assert.equal(passesHardFilter({ ...order, delivery_lat: null, delivery_lng: null }, base), false);
});

test("matchFlorists: an order that never geocoded matches nobody", () => {
  const nowhere = { delivery_lat: null, delivery_lng: null, delivery_at: null };
  assert.deepEqual(matchFlorists(nowhere, [base, at(2), at(4)]), []);
});

// ---------------------------------------------------------------------------
// Rings — distance is now the MOST significant sort key.
// ---------------------------------------------------------------------------

test("ringIndex: edges are inclusive, and past the last edge is out of range", () => {
  const c = cfg({ ringEdgesKm: [5, 10, 20] });
  assert.equal(ringIndex(0, c), 0);
  assert.equal(ringIndex(5, c), 0, "exactly on an edge belongs to the nearer ring");
  assert.equal(ringIndex(5.0001, c), 1);
  assert.equal(ringIndex(10, c), 1);
  assert.equal(ringIndex(20, c), 2);
  assert.equal(ringIndex(20.1, c), 3, "past the cap — the hard filter has already dropped these");
});

test("ringIndex: an unknown distance sorts LAST, never as 'nearest'", () => {
  assert.equal(ringIndex(null, cfg({ ringEdgesKm: [5, 10, 20] })), 3);
});

test("matchFlorists: a nearer ring beats a far, much stronger candidate", () => {
  // This is the whole point of the change. Before, the far onboarded shop won.
  const nearWeak = at(3, {
    id: "near-weak", lifecycle_stage: "engaged", source: "new",
    trust_tier: "3", rating: 3.0, review_count: 1, email: null,
  });
  const farStrong = at(12, {
    id: "far-strong", lifecycle_stage: "production", source: "existing",
    trust_tier: "1", rating: 5.0, review_count: 500, email: "a@b.com",
    delivery_radius_km: null, // no claim of its own -> reaches to the cap
  });
  const ranked = matchFlorists(order, [farStrong, nearWeak]);
  assert.deepEqual(ranked.map((c) => c.florist_id), ["near-weak", "far-strong"]);
  assert.equal(ranked[0].ring, 0);
  assert.equal(ranked[1].ring, 2);
});

test("matchFlorists: inside one ring, score decides — the onboarded bonus is a term, not a veto", () => {
  const onboardedWeak = at(2, {
    id: "onboarded-weak", lifecycle_stage: "production",
    trust_tier: "3", rating: 3.0, review_count: 1, source: "new", email: null,
  });
  const prospectStrong = at(2, {
    id: "prospect-strong", lifecycle_stage: "engaged",
    trust_tier: "1", rating: 5.0, review_count: 500, source: "existing", email: "a@b.com",
  });
  const ranked = matchFlorists(order, [onboardedWeak, prospectStrong]);
  assert.equal(ranked[0].florist_id, "prospect-strong");
  assert.equal(ranked[0].ring, ranked[1].ring, "both in the same ring — score alone separated them");
});

test("matchFlorists: all else equal in a ring, the onboarded shop wins", () => {
  const onboarded = at(2, { id: "onboarded", lifecycle_stage: "production" });
  const prospect = at(2, { id: "prospect", lifecycle_stage: "engaged" });
  assert.equal(matchFlorists(order, [prospect, onboarded])[0].florist_id, "onboarded");
});

test("matchFlorists: all else equal in a ring, the nearer shop wins", () => {
  // The within-ring distance term is what softens the cliff at each edge.
  const near = at(1, { id: "near" });
  const far = at(4, { id: "far" });
  assert.deepEqual(matchFlorists(order, [far, near]).map((c) => c.florist_id), ["near", "far"]);
});

test("matchFlorists: ring edges are configurable — one big ring makes score decide outright", () => {
  const nearWeak = at(3, { id: "near-weak", rating: 3.0, review_count: 1, source: "new", trust_tier: "3" });
  const farStrong = at(12, { id: "far-strong", rating: 5.0, review_count: 500, source: "existing", trust_tier: "1", delivery_radius_km: null });
  const ranked = matchFlorists(order, [nearWeak, farStrong], cfg({ ringEdgesKm: [20] }));
  assert.deepEqual(ranked.map((c) => c.florist_id), ["far-strong", "near-weak"]);
});

// ---------------------------------------------------------------------------
// Quality floors — null-safe by construction.
// ---------------------------------------------------------------------------

test("passesQualityFloor: minRating", () => {
  assert.equal(passesQualityFloor({ ...base, rating: 4.6 }, cfg({ minRating: 4.0 })), true);
  assert.equal(passesQualityFloor({ ...base, rating: 3.2 }, cfg({ minRating: 4.0 })), false);
  assert.equal(passesQualityFloor({ ...base, rating: 4.0 }, cfg({ minRating: 4.0 })), true, "the floor is inclusive");
});

test("passesQualityFloor: an unrated florist is governed by allowUnrated, never by NaN", () => {
  const unrated = { ...base, rating: null };
  assert.equal(passesQualityFloor(unrated, cfg({ minRating: 4.0, allowUnrated: true })), true);
  assert.equal(passesQualityFloor(unrated, cfg({ minRating: 4.0, allowUnrated: false })), false);
  // With no floor at all, allowUnrated is irrelevant — nothing to compare against.
  assert.equal(passesQualityFloor(unrated, cfg({ minRating: null, allowUnrated: false })), true);
});

test("passesQualityFloor: minReviewCount treats null as zero", () => {
  assert.equal(passesQualityFloor({ ...base, review_count: null }, cfg({ minReviewCount: 10 })), false);
  assert.equal(passesQualityFloor({ ...base, review_count: 10 }, cfg({ minReviewCount: 10 })), true);
  assert.equal(passesQualityFloor({ ...base, review_count: null }, cfg({ minReviewCount: null })), true);
});

test("passesQualityFloor: excludeTier4 drops the flagged tier only", () => {
  const c = cfg({ excludeTier4: true });
  assert.equal(passesQualityFloor({ ...base, trust_tier: "4" }, c), false);
  assert.equal(passesQualityFloor({ ...base, trust_tier: "3" }, c), true);
  assert.equal(passesQualityFloor({ ...base, trust_tier: "4" }, DEFAULT_MATCH_CONFIG), true, "off by default");
});

test("matchFlorists: quality floors drop candidates entirely, not just rank them lower", () => {
  const good = at(2, { id: "good", rating: 4.8, review_count: 200 });
  const poor = at(1, { id: "poor", rating: 2.9, review_count: 200 });
  const ranked = matchFlorists(order, [poor, good], cfg({ minRating: 4.0 }));
  assert.deepEqual(ranked.map((c) => c.florist_id), ["good"]);
});

// ---------------------------------------------------------------------------
// topN, and its ordering against the two dedupes.
// ---------------------------------------------------------------------------

test("matchFlorists: topN caps the candidate list", () => {
  const many = [at(1, { id: "a", place_id: "A" }), at(2, { id: "b", place_id: "B" }), at(3, { id: "c", place_id: "C" }), at(4, { id: "d", place_id: "D" })];
  assert.equal(matchFlorists(order, many).length, 3, "default topN");
  assert.equal(matchFlorists(order, many, cfg({ topN: 2 })).length, 2);
  assert.equal(matchFlorists(order, many, cfg({ topN: 10 })).length, 4);
});

test("matchFlorists: topN is applied AFTER both dedupes, so duplicates don't eat the budget", () => {
  // Three rows of one shop plus two real alternatives. Trimming before the
  // collapse would return one shop and one alternative; after, it returns three
  // distinct shops.
  const dupes = [
    at(1, { id: "dup-1", place_id: "SAME", email: "one@shop.com" }),
    at(1, { id: "dup-2", place_id: "SAME", email: "two@shop.com" }),
    at(1, { id: "dup-3", place_id: "SAME", email: "three@shop.com" }),
    at(2, { id: "other-1", place_id: "B", email: "b@shop.com" }),
    at(3, { id: "other-2", place_id: "C", email: "c@shop.com" }),
  ];
  const ranked = matchFlorists(order, dupes, cfg({ topN: 3 }));
  assert.equal(ranked.length, 3);
  assert.deepEqual(ranked.map((c) => c.florist_id).slice(1), ["other-1", "other-2"]);
  assert.deepEqual(ranked.map((c) => c.rank), [1, 2, 3], "ranks stay contiguous");
});

// ---------------------------------------------------------------------------
// Score breakdown — the backoffice explains a ranking with this.
// ---------------------------------------------------------------------------

test("matchFlorists: the breakdown sums to the score", () => {
  const [c] = matchFlorists(order, [at(3, { id: "x", email: "a@b.com" })]);
  const sum = Object.values(c.breakdown).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - c.score) < 1e-9, `breakdown ${sum} != score ${c.score}`);
});

test("matchFlorists: the distance term is negative and the bonuses are on/off", () => {
  const [c] = matchFlorists(order, [at(4, { id: "x", lifecycle_stage: "production", email: "a@b.com" })]);
  assert.ok(c.breakdown.distance < 0, "distance always subtracts");
  assert.equal(c.breakdown.onboarded, DEFAULT_MATCH_CONFIG.weights.onboarded);
  assert.equal(c.breakdown.emailable, DEFAULT_MATCH_CONFIG.weights.emailable);
  const [d] = matchFlorists(order, [at(4, { id: "y", lifecycle_stage: "engaged", email: null })]);
  assert.equal(d.breakdown.onboarded, 0);
  assert.equal(d.breakdown.emailable, 0);
});

// ---------------------------------------------------------------------------
// Dedupe: same storefront, then same inbox.
// ---------------------------------------------------------------------------

test("matchFlorists: same physical shop (shared place_id) is offered only once — the best record wins", () => {
  // Two florist rows for the same storefront (same place_id, different id) — the
  // real-world case of a shop ingested under two cities. The stronger record must
  // win and the weaker duplicate must be dropped entirely, with contiguous ranks.
  const strong = at(2, { id: "shop-strong", place_id: "PLACE_A", rating: 4.8, review_count: 300 });
  const weak = at(2, { id: "shop-weak", place_id: "PLACE_A", rating: 3.1, review_count: 2 });
  const other = at(2, { id: "other", place_id: "PLACE_B", rating: 4.0, review_count: 50 });
  const ranked = matchFlorists(order, [weak, strong, other]);
  assert.equal(ranked.length, 2, "the duplicate shop collapses to one candidate");
  const ids = ranked.map((c) => c.florist_id);
  assert.ok(ids.includes("shop-strong"), "keeps the higher-scored record of the shop");
  assert.ok(!ids.includes("shop-weak"), "drops the weaker duplicate of the same shop");
  assert.deepEqual(ranked.map((c) => c.rank), [1, 2], "ranks stay contiguous after collapse");
});

test("matchFlorists: records without a place_id are never collapsed together", () => {
  // A missing place_id can't prove two rows are the same shop, so both are kept.
  const a = at(2, { id: "no-place-a", place_id: null, rating: 4.5, review_count: 40 });
  const b = at(2, { id: "no-place-b", place_id: null, rating: 4.4, review_count: 40 });
  const ranked = matchFlorists(order, [a, b]);
  assert.equal(ranked.length, 2);
  assert.deepEqual(new Set(ranked.map((c) => c.florist_id)), new Set(["no-place-a", "no-place-b"]));
});

test("matchFlorists: an emailable florist outranks an identical email-less one, which is kept as a fallback", () => {
  // Email is the authoritative leg, so it's a scored preference — not a filter.
  // The email-less florist still appears, reachable by SMS + push.
  const withEmail = at(2, { id: "with-email", email: "shop@example.com" });
  const noEmail = at(2, { id: "no-email", email: null });
  const ranked = matchFlorists(order, [noEmail, withEmail]);
  assert.deepEqual(ranked.map((c) => c.florist_id), ["with-email", "no-email"]);
  assert.equal(ranked.length, 2, "the email-less florist is kept as a fallback, not dropped");
});

test("matchFlorists: a blank/whitespace-only email counts as no email", () => {
  const blank = at(2, { id: "blank-email", email: "   " });
  const real = at(2, { id: "real-email", email: "a@b.com" });
  const ranked = matchFlorists(order, [blank, real]);
  assert.equal(ranked[0].florist_id, "real-email");
  assert.equal(ranked[1].florist_id, "blank-email");
});

test("matchFlorists: two shops sharing an email are offered once — the best record wins", () => {
  const strong = at(2, { id: "strong", place_id: "P_A", email: "contact@network.fr", rating: 4.8, review_count: 300 });
  const weak = at(2, { id: "weak", place_id: "P_B", email: "contact@network.fr", rating: 3.1, review_count: 2 });
  const ranked = matchFlorists(order, [weak, strong]);
  assert.deepEqual(ranked.map((c) => c.florist_id), ["strong"]);
});

test("matchFlorists: the email match is case- and whitespace-insensitive", () => {
  const a = at(2, { id: "a", place_id: "P_A", email: "Contact@Network.FR", rating: 4.8 });
  const b = at(2, { id: "b", place_id: "P_B", email: "  contact@network.fr ", rating: 3.1 });
  assert.deepEqual(matchFlorists(order, [a, b]).map((c) => c.florist_id), ["a"]);
});

test("matchFlorists: florists without an email are never collapsed together", () => {
  // Absence of an address can't prove two rows share an inbox — same reasoning
  // as the null place_id case above.
  const a = at(2, { id: "no-email-a", place_id: "P_A", email: null, rating: 4.5 });
  const b = at(2, { id: "no-email-b", place_id: "P_B", email: "   ", rating: 4.4 });
  assert.equal(matchFlorists(order, [a, b]).length, 2);
});

// The flags say "this address is not this shop's". The shop itself is real and
// still reachable by SMS + push, so it must SURVIVE matching — dropping it
// would throw away a deliverable florist to protect an inbox we already
// decided not to write to.

test("matchFlorists: network shops sharing the network's address all survive", () => {
  const a = at(2, { id: "shop-a", place_id: "P_A", email: "contact@reseau-demo.fr", network_id: "net-1", rating: 4.8 });
  const b = at(2, { id: "shop-b", place_id: "P_B", email: "contact@reseau-demo.fr", network_id: "net-1", rating: 4.4 });
  const c = at(2, { id: "shop-c", place_id: "P_C", email: "contact@reseau-demo.fr", network_id: "net-1", rating: 4.0 });
  assert.deepEqual(matchFlorists(order, [a, b, c]).map((x) => x.florist_id), ["shop-a", "shop-b", "shop-c"]);
});

test("matchFlorists: a flagged-shared address survives too (both shops keep SMS + push)", () => {
  const a = at(2, { id: "a", place_id: "P_A", email: "shared@gmail.com", email_shared_count: 2, rating: 4.8 });
  const b = at(2, { id: "b", place_id: "P_B", email: "shared@gmail.com", email_shared_count: 2, rating: 4.4 });
  assert.equal(matchFlorists(order, [a, b]).length, 2);
});

test("matchFlorists: an unusable address does not outrank a usable one", () => {
  // A florist holding a network's head-office address is no more emailable than
  // one holding nothing, so it must not collect the emailable bonus.
  const networked = at(2, { id: "networked", place_id: "P_A", email: "contact@reseau-demo.fr", network_id: "net-1", rating: 4.4, review_count: 100 });
  const emailable = at(2, { id: "emailable", place_id: "P_C", email: "hello@shop.fr", rating: 4.4, review_count: 100 });
  assert.equal(matchFlorists(order, [networked, emailable])[0].florist_id, "emailable");
});

// ---------------------------------------------------------------------------
// Test shops (supabase/migrations/2026-08-05-test-shops.sql).
// ---------------------------------------------------------------------------

const shop = { ...base, is_test_shop: true };

test("test shops are excluded by default", () => {
  assert.equal(passesHardFilter(order, shop), false);
  assert.equal(passesHardFilter(order, shop, "exclude"), false);
  assert.equal(passesHardFilter(order, base), true);
});

test("'only' mode inverts it — test shops in, everyone else out", () => {
  assert.equal(passesHardFilter(order, shop, "only"), true);
  assert.equal(passesHardFilter(order, base, "only"), false);
});

test("an absent/null flag means 'not a test shop'", () => {
  assert.equal(passesHardFilter(order, { ...base, is_test_shop: null }, "exclude"), true);
  assert.equal(passesHardFilter(order, { ...base, is_test_shop: undefined }, "exclude"), true);
  assert.equal(passesHardFilter(order, { ...base, is_test_shop: null }, "only"), false);
});

test("'only' widens nothing else — a denylisted or lost test shop is still rejected", () => {
  assert.equal(passesHardFilter(order, { ...shop, excluded_at: "2026-01-01" }, "only"), false);
  assert.equal(passesHardFilter(order, { ...shop, lifecycle_stage: "lost" }, "only"), false);
});

test("matchFlorists threads the mode through to the hard filter", () => {
  const florists = [{ ...base, id: "real" }, { ...base, id: "test", is_test_shop: true }];
  assert.deepEqual(matchFlorists(order, florists).map((c) => c.florist_id), ["real"]);
  assert.deepEqual(matchFlorists(order, florists, undefined, "exclude").map((c) => c.florist_id), ["real"]);
  assert.deepEqual(matchFlorists(order, florists, undefined, "only").map((c) => c.florist_id), ["test"]);
});

// ---------------------------------------------------------------------------
// The generated worker copy.
// ---------------------------------------------------------------------------

test("ingest-worker/src/match.ts is byte-identical to this file's source", async () => {
  // The worker and dashboard are separate builds and can't import from each
  // other, so the matcher exists twice. It used to be two hand-maintained copies
  // "kept in step" plus a couple of regex assertions — and it drifted three ways
  // anyway (performance term, capacity filter, null-radius/null-tier guards)
  // without the regexes noticing, so the automatic match and the backoffice
  // re-match were ranking florists differently.
  //
  // Byte equality replaces all of that: there is nothing left to approximate.
  const { readFileSync } = await import("node:fs");
  const canonical = readFileSync(new URL("./match.ts", import.meta.url), "utf8");
  const generated = readFileSync(new URL("../../ingest-worker/src/match.ts", import.meta.url), "utf8");
  assert.equal(
    generated,
    canonical,
    "ingest-worker/src/match.ts is out of date — run `npm run sync:match` from dashboard/"
  );
});

// ---------------------------------------------------------------------------
// MatchConfig loading — a bad settings row must never stop matching.
// ---------------------------------------------------------------------------

import { parseMatchConfig, parseRingEdges, boundingBox } from "./match.ts";

test("parseMatchConfig: a null row yields the compiled defaults", () => {
  assert.deepEqual(parseMatchConfig(null), DEFAULT_MATCH_CONFIG);
  assert.deepEqual(parseMatchConfig(undefined), DEFAULT_MATCH_CONFIG);
});

test("parseMatchConfig: reads a well-formed row", () => {
  const c = parseMatchConfig({
    match_ring_edges_km: [3, 8, 15],
    match_weight_distance: 0.5, match_weight_onboarded: 1, match_weight_emailable: 2,
    match_weight_quality: 3, match_weight_source: 4, match_weight_tier: 5, match_weight_performance: 6,
    match_top_n: 7, match_min_rating: 4.2, match_min_review_count: 25,
    match_allow_unrated: false, match_exclude_tier4: true, match_require_trust_tier: false,
  });
  assert.deepEqual(c.ringEdgesKm, [3, 8, 15]);
  assert.deepEqual(c.weights, { distance: 0.5, onboarded: 1, emailable: 2, quality: 3, source: 4, tier: 5, performance: 6 });
  assert.equal(c.topN, 7);
  assert.equal(c.minRating, 4.2);
  assert.equal(c.minReviewCount, 25);
  assert.equal(c.allowUnrated, false);
  assert.equal(c.excludeTier4, true);
  assert.equal(c.requireTrustTier, false);
});

test("parseMatchConfig: numeric columns arriving as strings still parse", () => {
  // PostgREST can hand back `numeric` as a string depending on the driver.
  const c = parseMatchConfig({ match_weight_distance: "0.75", match_ring_edges_km: ["4", "9"], match_top_n: "5" });
  assert.equal(c.weights.distance, 0.75);
  assert.deepEqual(c.ringEdgesKm, [4, 9]);
  assert.equal(c.topN, 5);
});

test("parseMatchConfig: a malformed field falls back on its own, not wholesale", () => {
  const c = parseMatchConfig({ match_weight_distance: "banana", match_weight_quality: 9 });
  assert.equal(c.weights.distance, DEFAULT_MATCH_CONFIG.weights.distance, "the bad field defaults");
  assert.equal(c.weights.quality, 9, "the good field beside it is kept");
});

test("parseRingEdges: a half-valid ladder is rejected whole", () => {
  const D = DEFAULT_MATCH_CONFIG.ringEdgesKm;
  assert.deepEqual(parseRingEdges([10, 5]), D, "descending");
  assert.deepEqual(parseRingEdges([5, 5]), D, "not strictly ascending");
  assert.deepEqual(parseRingEdges([5, 0, 20]), D, "non-positive edge");
  assert.deepEqual(parseRingEdges([5, "x", 20]), D, "non-numeric edge");
  assert.deepEqual(parseRingEdges([]), D, "empty");
  assert.deepEqual(parseRingEdges(null), D);
  assert.deepEqual(parseRingEdges("5,10"), D, "not an array");
  assert.deepEqual(parseRingEdges([5, 10, 20]), [5, 10, 20], "a valid ladder is kept");
});

test("parseMatchConfig: topN floors at 1 — a 0 would strand every order", () => {
  assert.equal(parseMatchConfig({ match_top_n: 0 }).topN, 1);
  assert.equal(parseMatchConfig({ match_top_n: -5 }).topN, 1);
  assert.equal(parseMatchConfig({ match_top_n: 2.6 }).topN, 3, "rounds to a whole count");
});

test("parseMatchConfig: the quality floors keep null as 'no floor'", () => {
  const c = parseMatchConfig({ match_min_rating: null, match_min_review_count: null });
  assert.equal(c.minRating, null);
  assert.equal(c.minReviewCount, null);
});

// ---------------------------------------------------------------------------
// boundingBox — the candidate query's index-usable prefilter.
// ---------------------------------------------------------------------------

test("boundingBox: contains every point within the radius", () => {
  const box = boundingBox(41.98, 2.82, 20);
  // A florist exactly 20km due north and one 20km due east must both be inside.
  const north = 41.98 + 20 / 111.32;
  const east = 2.82 + 20 / (111.32 * Math.cos((41.98 * Math.PI) / 180));
  assert.ok(north <= box.maxLat + 1e-9, "north edge inside");
  assert.ok(east <= box.maxLng + 1e-9, "east edge inside");
  assert.ok(box.minLat < 41.98 && box.maxLat > 41.98);
  assert.ok(box.minLng < 2.82 && box.maxLng > 2.82);
});

test("boundingBox: the longitude span is clamped near the poles rather than exploding", () => {
  const box = boundingBox(90, 0, 20);
  assert.ok(Number.isFinite(box.minLng) && Number.isFinite(box.maxLng));
  assert.ok(box.maxLng - box.minLng <= 360 + 1e-9);
});
