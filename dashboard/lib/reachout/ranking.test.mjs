import test from "node:test";
import assert from "node:assert/strict";
import {
  tierOf, score, rankBreakdown, rankShops, collapseDuplicates,
  decay, hoursSince, HALF_LIFE_HOURS, RANK_WEIGHTS, TIER_LABEL,
} from "./ranking.ts";

const NOW = Date.parse("2026-09-09T17:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const agoH = (h) => new Date(NOW - h * HOUR).toISOString();

const shop = (over = {}) => ({ floristId: "f1", name: "Floristería", ...over });

// ---- tiers ----

test("the tiers run from joined down to suppressed", () => {
  assert.equal(tierOf(shop({ joinedAt: agoH(1) })), 0);
  assert.equal(tierOf(shop({ engagedAt: agoH(1) })), 1);
  assert.equal(tierOf(shop({ openedAt: agoH(1) })), 2);
  assert.equal(tierOf(shop({ deliveredCount: 1 })), 3);
  assert.equal(tierOf(shop({ touchesSent: 1 })), 4);
  assert.equal(tierOf(shop({ enrolled: true })), 5);
  assert.equal(tierOf(shop({})), 5);
  assert.equal(tierOf(shop({ suppressed: true })), 6);
  assert.equal(tierOf(shop({ bouncedCount: 1 })), 6);
});

test("a bounced shop sorts last however much it engaged first", () => {
  // Calling an address that hard-bounced is wasted; calling someone who opted
  // out is worse than wasted. Neither may ride an engagement score to the top.
  assert.equal(tierOf(shop({ engagedAt: agoH(0.1), clickCount: 5, suppressed: true })), 6);
});

test("joining beats everything, including a prior opt-out", () => {
  // Someone who unsubscribed and later joined anyway is in the network, and
  // that is the only fact that matters about them here.
  assert.equal(tierOf(shop({ joinedAt: agoH(1), suppressed: true, bouncedCount: 2 })), 0);
});

test("every tier has a label", () => {
  for (let t = 0; t <= 6; t++) assert.equal(typeof TIER_LABEL[t], "string");
});

// ---- decay ----

test("decay halves every half-life and never goes negative", () => {
  assert.equal(decay(0), 1);
  assert.equal(decay(HALF_LIFE_HOURS), 0.5);
  assert.ok(Math.abs(decay(2 * HALF_LIFE_HOURS) - 0.25) < 1e-12);
  assert.equal(decay(null), 0);
  assert.equal(decay(NaN), 0);
  assert.equal(decay(-5), 0);
});

test("a future timestamp clamps to now rather than scoring above 1", () => {
  // Clock skew between provider event timestamps is real; it must not invent
  // engagement stronger than the present.
  assert.equal(hoursSince(new Date(NOW + 5 * HOUR).toISOString(), NOW), 0);
  assert.equal(hoursSince(null, NOW), null);
  assert.equal(hoursSince("not a date", NOW), null);
});

// ---- score ----

test("a recent click outranks an old one", () => {
  const fresh = shop({ engagedAt: agoH(0.5), clickCount: 1, lastSignalAt: agoH(0.5) });
  const stale = shop({ engagedAt: agoH(72), clickCount: 1, lastSignalAt: agoH(72) });
  assert.ok(score(fresh, NOW) > score(stale, NOW), "recency did not move the score");
});

test("a click is worth more than an open", () => {
  const clicked = shop({ engagedAt: agoH(1), clickCount: 1 });
  const opened = shop({ openedAt: agoH(1), openCount: 1 });
  assert.ok(score(clicked, NOW) > score(opened, NOW));
});

test("repeat engagement counts for more than a single touch", () => {
  const once = shop({ engagedAt: agoH(1), clickCount: 1 });
  const thrice = shop({ engagedAt: agoH(1), clickCount: 3 });
  assert.ok(score(thrice, NOW) > score(once, NOW));
});

test("an unrated shop is neither helped nor punished", () => {
  // Cold-start neutrality, the same principle as match.ts::performanceTerm.
  assert.equal(rankBreakdown(shop({}), NOW).rating, 0);
  assert.ok(rankBreakdown(shop({ rating: 4.5 }), NOW).rating > 0);
  assert.ok(rankBreakdown(shop({ rating: 2.0 }), NOW).rating < 0);
});

test("fatigue pushes the most-mailed shops down", () => {
  const quiet = shop({ openedAt: agoH(1), touchesSent: 1 });
  const hammered = shop({ openedAt: agoH(1), touchesSent: 6 });
  assert.ok(score(quiet, NOW) > score(hammered, NOW));
  assert.ok(rankBreakdown(hammered, NOW).fatigue < 0, "fatigue is meant to subtract");
});

test("the breakdown sums to the score, so the UI can show its work", () => {
  const s = shop({ engagedAt: agoH(2), clickCount: 2, openedAt: agoH(3), openCount: 4, lastSignalAt: agoH(2), rating: 4.6, reviewCount: 120, touchesSent: 3 });
  const b = rankBreakdown(s, NOW);
  const sum = b.click + b.open + b.recency + b.rating + b.reviews + b.fatigue;
  assert.ok(Math.abs(sum - score(s, NOW)) < 1e-12);
});

// Every nullable input at once — per CLAUDE.md a null must never become NaN.
test("a shop with nothing but an id scores a finite number", () => {
  const empty = { floristId: "f1" };
  const s = score(empty, NOW);
  assert.ok(Number.isFinite(s), `score was ${s}`);
  for (const [k, v] of Object.entries(rankBreakdown(empty, NOW))) {
    assert.ok(Number.isFinite(v), `${k} was ${v}`);
  }
});

test("explicit nulls score the same as absent fields", () => {
  const nulls = { floristId: "f1", rating: null, reviewCount: null, touchesSent: null, clickCount: null, openCount: null, engagedAt: null, openedAt: null, lastSignalAt: null };
  assert.equal(score(nulls, NOW), score({ floristId: "f1" }, NOW));
});

// ---- ranking ----

test("tier beats score: a five-star opener never outranks a scruffy clicker", () => {
  const ranked = rankShops([
    shop({ floristId: "opener", name: "A", openedAt: agoH(0.1), openCount: 9, rating: 5, reviewCount: 5000 }),
    shop({ floristId: "clicker", name: "Z", engagedAt: agoH(40), clickCount: 1, rating: 3, reviewCount: 1 }),
  ], NOW);
  assert.equal(ranked[0].floristId, "clicker", "score overtook tier");
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
});

test("joined shops sit at the top", () => {
  const ranked = rankShops([
    shop({ floristId: "clicked", engagedAt: agoH(0.1), clickCount: 9 }),
    shop({ floristId: "joined", joinedAt: agoH(50) }),
  ], NOW);
  assert.equal(ranked[0].floristId, "joined");
});

test("ties break on name, so the order is stable across renders", () => {
  const a = shop({ floristId: "a", name: "Aaa", enrolled: true });
  const z = shop({ floristId: "z", name: "Zzz", enrolled: true });
  assert.deepEqual(rankShops([z, a], NOW).map((s) => s.floristId), ["a", "z"]);
  assert.deepEqual(rankShops([a, z], NOW).map((s) => s.floristId), ["a", "z"]);
});

test("ranks are 1-based and contiguous", () => {
  const ranked = rankShops([shop({ floristId: "1" }), shop({ floristId: "2" }), shop({ floristId: "3" })], NOW);
  assert.deepEqual(ranked.map((s) => s.rank), [1, 2, 3]);
});

// ---- duplicate listings ----

test("duplicate listings of one business collapse to the row that got furthest", () => {
  // Measured on prod: 89 of Spain's 132 shared-address shops are the SAME name
  // listed twice. The funnel mails one listing per inbox, so without this the
  // others read as "never messaged" and CS rings a shop already contacted.
  const ranked = rankShops([
    shop({ floristId: "listing-a", name: "Flors Bcn", email: "Hola@flors.example", engagedAt: agoH(1), clickCount: 1 }),
    shop({ floristId: "listing-b", name: "Flors Bcn", email: "hola@flors.example" }),
  ], NOW);
  const out = collapseDuplicates(ranked);
  assert.equal(out.length, 1, "the duplicate listing survived");
  assert.equal(out[0].floristId, "listing-a", "kept the row that had not engaged");
  assert.equal(out[0].rank, 1);
});

test("shops with no email never collide with each other", () => {
  const ranked = rankShops([
    shop({ floristId: "x", name: "X", email: null }),
    shop({ floristId: "y", name: "Y", email: null }),
  ], NOW);
  assert.equal(collapseDuplicates(ranked).length, 2);
});

test("different businesses on one address still collapse, and that is deliberate", () => {
  // 40 Spanish shops are genuinely different businesses sharing an inbox. The
  // funnel can only mail that inbox once, so the call list must show it once —
  // otherwise CS phones two shops about an email only one of them received.
  const ranked = rankShops([
    shop({ floristId: "a", name: "Rosas", email: "info@centro.example", openedAt: agoH(1) }),
    shop({ floristId: "b", name: "Claveles", email: "info@centro.example" }),
  ], NOW);
  assert.equal(collapseDuplicates(ranked).length, 1);
});
