// Who Customer Service should call next.
//
// Pure and alias-free, and shaped like lib/scoring.ts — `tier` / `score` /
// `rankBreakdown`, with the breakdown existing so the table can EXPLAIN a
// position instead of asserting one. A CS agent who cannot see why a shop is
// third stops trusting the order, and then the list is just a spreadsheet.
//
// ---- Tier first, score second
//
// The same shape as lib/match.ts's "ring first, score second". The primary
// ordering is categorical because the question is categorical: a shop that
// clicked and did not join is a different KIND of prospect from one that only
// opened, and no amount of star rating should let the second overtake the
// first. Score only breaks ties inside a tier.
//
// ---- The decay is in HOURS
//
// The funnel resolves inside one working day. A seven-day half-life would score
// every shop in it almost identically and the list would be useless for the one
// question it exists to answer, which is who to call RIGHT NOW. Eight hours
// means a click this morning still outranks one from yesterday afternoon.

export type ReachOutTier = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const TIER_LABEL: Record<ReachOutTier, string> = {
  0: "Joined",
  1: "Clicked, not joined",
  2: "Opened, never clicked",
  3: "Delivered, never opened",
  4: "Sent, no feedback",
  5: "Enrolled, nothing sent",
  6: "Bounced or opted out",
};

/** One shop's signals, as get_reachout_signals returns them. Every field is
 * nullable because every one of them can genuinely be unknown. */
export interface ReachOutSignals {
  floristId: string;
  name?: string | null;
  city?: string | null;
  email?: string | null;
  phone?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  /** Non-null once they self-registered. */
  joinedAt?: string | null;
  /** The scanner-filtered first click (sequence_enrolments.engaged_at). */
  engagedAt?: string | null;
  /** The prefetch-filtered first open (sequence_enrolments.opened_at). */
  openedAt?: string | null;
  /** Provider events on this shop's recruiting mail. */
  clickCount?: number | null;
  openCount?: number | null;
  deliveredCount?: number | null;
  bouncedCount?: number | null;
  /** Recruiting messages actually sent. */
  touchesSent?: number | null;
  /** True once the run ended because they bounced or opted out. */
  suppressed?: boolean | null;
  /** They have an enrolment at all. */
  enrolled?: boolean | null;
  /** Most recent open or click, whichever is later. */
  lastSignalAt?: string | null;
}

export const HALF_LIFE_HOURS = 8;

export const RANK_WEIGHTS = {
  click: 3.0,
  open: 1.0,
  recency: 2.0,
  rating: 0.6,
  reviews: 0.4,
  fatigue: 0.3,
} as const;

export type RankWeights = typeof RANK_WEIGHTS;

const HOUR_MS = 60 * 60 * 1000;

/** 1 at zero hours, ½ at HALF_LIFE_HOURS, asymptotically 0. Guarded so a
 * missing or unparseable timestamp contributes nothing rather than NaN. */
export function decay(hours: number | null): number {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return 0;
  return Math.pow(0.5, hours / HALF_LIFE_HOURS);
}

/** Hours between `iso` and `nowMs`, or null when there is no usable timestamp.
 * A future timestamp clamps to 0 rather than scoring above 1 — clock skew
 * between provider events is real and must not invent engagement. */
export function hoursSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / HOUR_MS);
}

/**
 * Which bucket this shop is in.
 *
 * Ordered by how close the shop is to joining, EXCEPT tier 6, which is not a
 * distance at all — a bounced or opted-out shop must never appear near the top
 * however much it engaged first, because calling it is at best wasted and at
 * worst unlawful. Checked before everything but `joined`: someone who opted out
 * and then joined anyway is in the network, and that is what matters.
 */
export function tierOf(s: ReachOutSignals): ReachOutTier {
  if (s.joinedAt) return 0;
  if (s.suppressed || (s.bouncedCount ?? 0) > 0) return 6;
  if (s.engagedAt || (s.clickCount ?? 0) > 0) return 1;
  if (s.openedAt || (s.openCount ?? 0) > 0) return 2;
  if ((s.deliveredCount ?? 0) > 0) return 3;
  if ((s.touchesSent ?? 0) > 0) return 4;
  if (s.enrolled) return 5;
  // Not enrolled and never messaged. Nothing has happened to them at all, so
  // they sort with the "nothing sent" group rather than inventing an eighth
  // tier for a state CS cannot act on differently.
  return 5;
}

export interface RankBreakdown {
  click: number;
  open: number;
  recency: number;
  rating: number;
  reviews: number;
  fatigue: number;
}

/** Every term, separately, so the UI can show its work. Sums to `score`. */
export function rankBreakdown(
  s: ReachOutSignals,
  nowMs: number,
  w: RankWeights = RANK_WEIGHTS
): RankBreakdown {
  // Weighted by recency of the FIRST click/open we know about, times how many
  // there were. Repeat engagement is real interest; one scanner-surviving click
  // three days ago is not the same as three clicks this morning.
  const clickDecay = decay(hoursSince(s.engagedAt, nowMs));
  const openDecay = decay(hoursSince(s.openedAt, nowMs));
  return {
    click: w.click * clickDecay * Math.max(0, s.clickCount ?? (s.engagedAt ? 1 : 0)),
    open: w.open * openDecay * Math.max(0, s.openCount ?? (s.openedAt ? 1 : 0)),
    recency: w.recency * decay(hoursSince(s.lastSignalAt, nowMs)),
    // Centred on 3.0 so an unrated shop scores 0 — neither helped nor punished.
    // Same cold-start principle as lib/match.ts::performanceTerm.
    rating: w.rating * ((s.rating ?? 3.0) - 3.0),
    reviews: w.reviews * Math.log10(Math.max(0, s.reviewCount ?? 0) + 1),
    // Negative: the more mail a shop has had without acting, the less a call is
    // likely to be welcome. Keeps the top of the list fresh rather than letting
    // the most-emailed shops accumulate there.
    fatigue: -w.fatigue * Math.max(0, s.touchesSent ?? 0),
  };
}

export function score(s: ReachOutSignals, nowMs: number, w: RankWeights = RANK_WEIGHTS): number {
  const b = rankBreakdown(s, nowMs, w);
  const total = b.click + b.open + b.recency + b.rating + b.reviews + b.fatigue;
  // Belt and braces: every term above is individually null-guarded, but a
  // caller passing a NaN weight would poison the sort silently.
  return Number.isFinite(total) ? total : 0;
}

export interface RankedShop extends ReachOutSignals {
  tier: ReachOutTier;
  score: number;
  breakdown: RankBreakdown;
  /** 1-based, after sorting. */
  rank: number;
}

/**
 * The call list: tier ascending, score descending, name as the final tiebreak
 * so the order is stable across renders and two shops that score identically do
 * not swap places on every refresh.
 */
export function rankShops(
  shops: readonly ReachOutSignals[],
  nowMs: number,
  w: RankWeights = RANK_WEIGHTS
): RankedShop[] {
  return shops
    .map((s) => ({ ...s, tier: tierOf(s), score: score(s, nowMs, w), breakdown: rankBreakdown(s, nowMs, w) }))
    .sort((a, b) =>
      a.tier !== b.tier ? a.tier - b.tier
      : b.score !== a.score ? b.score - a.score
      : (a.name ?? "").localeCompare(b.name ?? "")
    )
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

/**
 * Collapse duplicate Google Maps listings of the same business.
 *
 * Measured on prod: 132 of Spain's 484 emailable shops share an address, and
 * 89 of those are the SAME shop name listed more than once. The funnel already
 * mails one listing per inbox (autoEnrol refuses `shared-address`), so without
 * this the other listings would sit in the call list reading "never messaged"
 * and CS would ring a florist whose colleague — or whose own second listing —
 * was already contacted.
 *
 * Keeps the row that got furthest: best tier, then best score. Grouped on
 * lower-cased email, because that is the identity the funnel itself dedupes on
 * (lib/sequences/contactIdentity.ts). Shops with no email cannot collide and
 * are always kept.
 */
export function collapseDuplicates(shops: readonly RankedShop[]): RankedShop[] {
  const best = new Map<string, RankedShop>();
  const kept: RankedShop[] = [];
  for (const s of shops) {
    const key = s.email?.trim().toLowerCase();
    if (!key) { kept.push(s); continue; }
    const prior = best.get(key);
    if (!prior || s.tier < prior.tier || (s.tier === prior.tier && s.score > prior.score)) {
      best.set(key, s);
    }
  }
  return [...kept, ...best.values()]
    .sort((a, b) => (a.rank - b.rank))
    .map((s, i) => ({ ...s, rank: i + 1 }));
}
