// ORDER → FLORIST MATCHING. Canonical copy.
//
// ingest-worker/src/match.ts is a BYTE-IDENTICAL generated copy of this file —
// run `npm run sync:match` after any edit here, and lib/match.test.mjs fails
// until you do. Do not edit the worker's copy by hand.
//
// The two used to be hand-maintained "in step" and drifted three ways (the
// performance term, the capacity filter, and the null-radius/null-tier guards
// were all missing from the dashboard side) without the regex lockstep guards
// noticing. Hence: one source, one generated copy, one byte-equality test.
//
// That constraint is why this file imports NOTHING — it has to compile under
// both the Next.js build and the Cloudflare Workers bundler, and be loadable by
// plain `node --test`. Inline the helper rather than importing it.
//
// ---------------------------------------------------------------------------
// HOW A FLORIST IS CHOSEN (see docs/superpowers/specs/2026-08-06-matching-rings-
// and-config-design.md):
//   1. hard filters drop anyone who must not receive this order at all;
//   2. survivors are bucketed into DISTANCE RINGS and sorted by ring first;
//   3. inside a ring, a weighted score decides;
//   4. duplicate shops and duplicate inboxes collapse;
//   5. the top `topN` become candidates.
// Everything numeric in steps 2-5 comes from MatchConfig, which is loaded from
// app_settings at call time — see lib/matchConfig.ts (dashboard) and
// ingest-worker/src/db.ts::loadMatchConfig (worker).

export interface MatchOrder {
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_at: string | null;
  // Carried by the worker's caller; matching does not read it today.
  line_items_types?: string[];
}

export interface MatchFlorist {
  id: string;
  // The Google Places id — the storefront's physical identity. The same shop can
  // exist as more than one florist row (ingest upserts on (city_id, place_id), so
  // a shop inside two cities' ingest radii is stored once per city, same place_id,
  // different id). matchFlorists collapses on this so a shop is never offered
  // twice. Optional: a florist without one just can't be de-duplicated.
  place_id?: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  review_count: number | null;
  lifecycle_stage: string | null;
  excluded_at: string | null;
  source: string | null;
  trust_tier: string | null;
  // The shop's own claimed reach. NULL for 5,816 of 5,829 florists as of
  // 2026-08-06, which is why it no longer rejects: the global cap
  // (config.ringEdgesKm's last edge) supplies the bound this used to, and a
  // null here simply means "use the cap". See effectiveRadiusKm.
  delivery_radius_km: number | null;
  capacity_per_day: number | null;
  // The florist's best-guess primary email. Reaching them by email is a scored
  // preference (weights.emailable), not a filter: the rest still appear lower as
  // a fallback, reachable by SMS + push.
  // Optional/nullable — an absent or blank value is treated as "no email".
  email?: string | null;
  // Set when `email` is not this SHOP's address but the head-office address of a
  // network/franchise/chain/directory whose site hosts its page (see
  // supabase/migrations/2026-08-06-florist-networks.sql). The shop is real and
  // reachable — only the address is wrong — so this does NOT filter the florist
  // out; it just means the address can't identify them (see emailIdentifies).
  network_id?: string | null;
  // How many florist rows hold this exact address. >1 = it identifies no single
  // shop. Defaults to 1 when absent, i.e. "assume the address is this shop's".
  email_shared_count?: number | null;
  // Set when the address hard-bounced (Resend webhook).
  email_bounced_at?: string | null;
  // How many assignments this florist already has in accepted/delivered status
  // for the order's delivery date (see ingest-worker/src/db.ts::countAcceptedForDay).
  // Optional + defaulted to 0 wherever read — this file is pure/sync and has no
  // DB access, so the caller computes and merges it in.
  accepted_count_for_day?: number;
  // All-time track record from the `florist_stats` view (supabase/migrations/
  // 2026-07-15-florist-stats.sql). All optional so fixtures/callers that predate
  // this field keep behaving as cold-start/neutral (see performanceTerm below).
  acceptance_rate?: number | null;
  on_time_rate?: number | null;
  sample_size?: number | null;
  // A florist WE own, used to exercise the real order loop end to end (see
  // supabase/migrations/2026-08-05-test-shops.sql). How matching treats these is
  // the `testShopMatching` argument below, NOT a property of the florist —
  // the flag says what the shop is, the mode says what to do about it.
  // Optional/nullable: absent means "not a test shop".
  is_test_shop?: boolean | null;
}

/** How automatic matching treats `is_test_shop` florists.
 *  - `exclude` (default): a paying customer's order can never reach a test shop.
 *  - `only`: matching routes EXCLUSIVELY to test shops, so the whole loop can be
 *    driven against a shop we own. Strands non-test orders in CX by design. */
export type TestShopMatching = "exclude" | "only";

/** Per-term multipliers for the within-ring score. `distance` is SUBTRACTED. */
export interface MatchWeights {
  distance: number;
  onboarded: number;
  emailable: number;
  quality: number;
  source: number;
  tier: number;
  performance: number;
}

/** Every runtime-tunable knob. Loaded from app_settings; the manual "Find
 *  florists" panel may override it for a single run without saving. */
export interface MatchConfig {
  /** Ascending km boundaries, e.g. [5, 10, 20]. Candidates are sorted by which
   *  ring they land in before anything else is considered. The LAST edge is
   *  also the hard distance cap — nothing beyond it is ever offered. */
  ringEdgesKm: number[];
  weights: MatchWeights;
  /** How many candidates a match writes. */
  topN: number;
  /** Quality floors. `null` means "no floor" for that field. */
  minRating: number | null;
  minReviewCount: number | null;
  /** Does a florist with NO rating pass minRating? Unrated ≠ bad — a fresh
   *  ingest often has no rating yet — so this defaults to true. */
  allowUnrated: boolean;
  /** Drop trust tier 4 (the "do not use" tier) outright. */
  excludeTier4: boolean;
  /** Require a trust tier. A florist without one cannot be PAID — lib/payout.ts
   *  looks the split up in `trust_tiers` by this code — so this defaults to
   *  true. Turning it off is a deliberate recruiting-run choice. */
  requireTrustTier: boolean;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  ringEdgesKm: [5, 10, 20],
  weights: {
    distance: 0.25,
    // Deliberately larger than `source: existing` (1.2 x 2 = 2.4): before rings
    // existed, onboarded-vs-not was a hard sort tier that no score could
    // overturn. Making it the biggest single bonus keeps that practical effect
    // WITHIN a ring, while letting a nearer ring win — which is the point.
    onboarded: 3.0,
    emailable: 1.5,
    quality: 1.0,
    source: 1.2,
    tier: 1.0,
    // Small relative to the others: a florist's own track record should nudge
    // ranking, not override an incumbent-vs-new-lead decision.
    performance: 0.4,
  },
  topN: 3,
  minRating: null,
  minReviewCount: null,
  allowUnrated: true,
  excludeTier4: false,
  requireTrustTier: true,
};

/** The app_settings columns a MatchConfig is built from. Both callers select
 *  exactly this list, so adding a knob means touching one place. */
export const MATCH_CONFIG_COLUMNS =
  "match_ring_edges_km, match_weight_distance, match_weight_onboarded, match_weight_emailable, " +
  "match_weight_quality, match_weight_source, match_weight_tier, match_weight_performance, " +
  "match_top_n, match_min_rating, match_min_review_count, match_allow_unrated, " +
  "match_exclude_tier4, match_require_trust_tier";

/** A finite number, or `fallback`. Coerces strings — PostgREST can return
 *  `numeric` either way depending on driver — but never turns junk into NaN. */
function num(v: unknown, fallback: number): number {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** A finite number, or null. Used for the "no floor" knobs, where null is a
 *  meaningful value rather than an absence to be defaulted. */
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Ring edges, or the default array. Rejected as a WHOLE if any edge is
 *  non-finite, non-positive, or out of order — a half-valid ladder would
 *  silently mis-bucket every candidate, which is worse than ignoring the row. */
export function parseRingEdges(v: unknown, fallback: number[] = DEFAULT_MATCH_CONFIG.ringEdgesKm): number[] {
  if (!Array.isArray(v) || v.length === 0) return fallback;
  const edges = v.map((e) => Number(e));
  if (!edges.every((e) => Number.isFinite(e) && e > 0)) return fallback;
  for (let i = 1; i < edges.length; i++) if (edges[i] <= edges[i - 1]) return fallback;
  return edges;
}

/**
 * Build a MatchConfig from an `app_settings` row.
 *
 * Falls back to DEFAULT_MATCH_CONFIG **per field**, so a null column, a row
 * written before the migration, or a single malformed value degrades to
 * known-good behavior instead of matching nobody. A null settings row (an
 * unreadable table, a failed request) yields the defaults wholesale — matching
 * must never be the thing that breaks because a settings read failed.
 */
export function parseMatchConfig(row: Record<string, unknown> | null | undefined): MatchConfig {
  const d = DEFAULT_MATCH_CONFIG;
  if (!row) return d;
  return {
    ringEdgesKm: parseRingEdges(row.match_ring_edges_km),
    weights: {
      distance: num(row.match_weight_distance, d.weights.distance),
      onboarded: num(row.match_weight_onboarded, d.weights.onboarded),
      emailable: num(row.match_weight_emailable, d.weights.emailable),
      quality: num(row.match_weight_quality, d.weights.quality),
      source: num(row.match_weight_source, d.weights.source),
      tier: num(row.match_weight_tier, d.weights.tier),
      performance: num(row.match_weight_performance, d.weights.performance),
    },
    // A topN below 1 would write no candidates at all and strand every order,
    // so it floors at 1 rather than falling back to the default — an operator
    // who typed 0 meant "as few as possible", not "three".
    topN: Math.max(1, Math.round(num(row.match_top_n, d.topN))),
    minRating: numOrNull(row.match_min_rating),
    minReviewCount: numOrNull(row.match_min_review_count),
    allowUnrated: bool(row.match_allow_unrated, d.allowUnrated),
    excludeTier4: bool(row.match_exclude_tier4, d.excludeTier4),
    requireTrustTier: bool(row.match_require_trust_tier, d.requireTrustTier),
  };
}

/** Each weighted term's contribution to a candidate's score, so the backoffice
 *  can explain a ranking instead of asserting one. Sums to `score`. */
export interface ScoreBreakdown {
  distance: number;
  onboarded: number;
  emailable: number;
  quality: number;
  source: number;
  tier: number;
  performance: number;
}

export interface Candidate {
  florist_id: string;
  rank: number;
  source: string | null;
  score: number;
  distance_km: number | null;
  /** Which distance ring this candidate landed in (0 = nearest). */
  ring: number;
  breakdown: ScoreBreakdown;
}

const SOURCE_SCORE: Record<string, number> = { existing: 2, known: 1, new: 0 };
const TIER_SCORE: Record<string, number> = { "1": 2, "2": 1, "3": 0, "4": -3 };
const ONBOARDED = ["production", "onboarding"];
// Every lifecycle_stage except `lost` is matchable. Exported so the candidate
// queries (worker + dashboard) load the same population the filter accepts.
export const MATCHABLE = ["production", "onboarding", "engaged", "contacted", "targeted", "found"];

// Bayesian smoothing prior for the performance term: prior_n=5, prior_rate=0.7 —
// a florist needs ~5 responses before their real acceptance/on-time rate starts
// to outweigh this neutral prior (chosen as "most florists are fine most of the
// time" rather than punishing/rewarding a 0-order florist relative to peers).
const PRIOR_N = 5;
const PRIOR_RATE = 0.7;

function smoothedRate(rate: number | null | undefined, n: number): number {
  const r = rate ?? PRIOR_RATE;
  return (n * r + PRIOR_N * PRIOR_RATE) / (n + PRIOR_N);
}

/** Centered at 0 for a cold-start florist (sample_size 0 or absent): both
 * smoothed rates collapse to PRIOR_RATE, so (smoothed - PRIOR_RATE) is 0 —
 * a brand-new florist never scores better or worse than another brand-new
 * florist because of this term. A florist with a track record above/below
 * the neutral prior nudges score up/down proportionally to how much data
 * backs it (see smoothedRate's n / (n + PRIOR_N) weighting). */
function performanceTerm(f: MatchFlorist): number {
  const n = f.sample_size ?? 0;
  const acc = smoothedRate(f.acceptance_rate, n);
  const onTime = smoothedRate(f.on_time_rate, n);
  return (acc - PRIOR_RATE) + (onTime - PRIOR_RATE);
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function distanceKm(o: MatchOrder, f: MatchFlorist): number | null {
  if (o.delivery_lat == null || o.delivery_lng == null || f.lat == null || f.lng == null) return null;
  return haversineKm({ lat: o.delivery_lat, lng: o.delivery_lng }, { lat: f.lat, lng: f.lng });
}

/** The hard distance cap: the last (largest) ring edge. */
export function capKm(config: MatchConfig): number {
  return config.ringEdgesKm[config.ringEdgesKm.length - 1];
}

/** A lat/lng box guaranteed to contain every point within `km` of the centre.
 *
 * The candidate query filters on this box (it's what an index can use) and
 * matchFlorists' exact haversine then trims the corners, so the box being
 * slightly generous costs nothing but a few extra rows.
 *
 * The longitude delta is clamped to 180°: cos(lat) → 0 approaching the poles,
 * which would otherwise produce an infinite span. Antimeridian wraparound is
 * NOT handled — no covered city is near ±180°, and a box that crossed it would
 * return nothing rather than something wrong.
 */
export function boundingBox(lat: number, lng: number, km: number): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const dLat = km / 111.32;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = Math.abs(cos) < 1e-9 ? 180 : Math.min(180, km / (111.32 * Math.abs(cos)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/** How far this florist may actually deliver for us. The cap FLOORS the shop's
 *  own claim, so a shop that typed "50" is still held to our ceiling; a shop
 *  that typed "5" is still held to 5. A null claim means "use the cap". */
export function effectiveRadiusKm(f: MatchFlorist, config: MatchConfig): number {
  const cap = capKm(config);
  return f.delivery_radius_km == null ? cap : Math.min(cap, f.delivery_radius_km);
}

/** Which ring a distance falls in — 0 is nearest. A distance past the last edge
 *  returns ringEdgesKm.length, which the hard filter has already excluded; a
 *  null distance is likewise unreachable here (also filtered) but returns the
 *  same worst bucket rather than 0, so an unknown distance can never sort as
 *  "nearest" if this is ever called directly. */
export function ringIndex(d: number | null, config: MatchConfig): number {
  if (d == null) return config.ringEdgesKm.length;
  for (let i = 0; i < config.ringEdgesKm.length; i++) {
    if (d <= config.ringEdgesKm[i]) return i;
  }
  return config.ringEdgesKm.length;
}

// Reachable-by-email? A blank/whitespace-only or null value counts as "no email".
function hasEmail(f: MatchFlorist): boolean {
  return typeof f.email === "string" && f.email.trim().length > 0;
}

/** The florist's address, lowercased and trimmed, or null when there isn't one. */
function normalizedEmail(f: MatchFlorist): string | null {
  if (!hasEmail(f)) return null;
  return f.email!.trim().toLowerCase();
}

/**
 * Does this florist's address actually IDENTIFY this florist?
 *
 * Not the same question as `hasEmail`. A shop can hold a perfectly valid,
 * deliverable address that is not its own: the head office of a network whose
 * site hosts its page, or a directory address that belongs to some unrelated
 * member. Reaching that address does not reach this shop.
 *
 * Returns false when the address is a known network's, is held by more than one
 * florist, or has hard-bounced. Kept in step with the offer path's own rule
 * (dashboard/lib/offerChannels.ts::emailSkipReason) — matching and sending must
 * agree on whether an address is usable, or matching would rank a florist first
 * for an email leg that the send then skips.
 */
export function emailIdentifies(f: MatchFlorist): boolean {
  if (!hasEmail(f)) return false;
  if (f.network_id) return false;
  if ((f.email_shared_count ?? 1) > 1) return false;
  if (f.email_bounced_at) return false;
  return true;
}

/** Quality floors. Null-safe throughout: an unrated florist is governed by
 *  `allowUnrated` rather than silently comparing null against a number, and a
 *  null review_count counts as 0. Neither can produce NaN. */
export function passesQualityFloor(f: MatchFlorist, config: MatchConfig): boolean {
  if (config.excludeTier4 && f.trust_tier === "4") return false;
  if (config.minRating != null) {
    if (f.rating == null) {
      if (!config.allowUnrated) return false;
    } else if (f.rating < config.minRating) {
      return false;
    }
  }
  if (config.minReviewCount != null && (f.review_count ?? 0) < config.minReviewCount) return false;
  return true;
}

export function passesHardFilter(
  o: MatchOrder,
  f: MatchFlorist,
  testShopMatching: TestShopMatching = "exclude",
  config: MatchConfig = DEFAULT_MATCH_CONFIG
): boolean {
  // Test shops first — this is the gate that keeps a paying customer's order off
  // a shop we own for testing, so it runs before anything else can let one
  // through. Defaults to `exclude`, so a caller that hasn't been updated fails
  // SAFE (test shops dropped) rather than open.
  if (testShopMatching === "only") {
    if (!f.is_test_shop) return false;
  } else if (f.is_test_shop) {
    return false;
  }
  if (f.excluded_at) return false; // denylist
  if (!MATCHABLE.includes(f.lifecycle_stage ?? "")) return false; // 'lost' is the only unmatchable stage
  // A florist we can't PAY must never receive a real order: lib/payout.ts
  // resolves the accept/delivery split from `trust_tiers` by this code, so a
  // null tier has no split. See dashboard/lib/floristActivation.ts for the
  // staff-facing "activatable" checklist this mirrors. Configurable because a
  // deliberate recruiting run wants the opposite.
  if (config.requireTrustTier && f.trust_tier == null) return false;
  if (!passesQualityFloor(f, config)) return false;
  // DISTANCE. An unknown distance now EXCLUDES rather than passing silently:
  // before rings, a null delivery_lat/lng meant every florist cleared the radius
  // check and scored distance-0, so an order we couldn't locate was offered to
  // an essentially arbitrary shop. If we can't tell how far away they are, we
  // don't offer — the order escalates to CX instead.
  const d = distanceKm(o, f);
  if (d == null) return false;
  if (d > effectiveRadiusKm(f, config)) return false;
  if (f.capacity_per_day != null && (f.accepted_count_for_day ?? 0) >= f.capacity_per_day) return false;
  return true;
}

export type CandidatePoolStatus = "ok" | "no_candidates" | "missing_delivery_coordinates" | "no_candidates_within_radius";

export function evaluateCandidatePool(
  florists: Pick<MatchFlorist, "lat" | "lng">[],
  order: Pick<MatchOrder, "delivery_lat" | "delivery_lng">,
  radiusKm: number,
): CandidatePoolStatus {
  if (florists.length === 0) return "no_candidates";
  if (order.delivery_lat == null || order.delivery_lng == null) return "missing_delivery_coordinates";
  for (const f of florists) {
    if (f.lat == null || f.lng == null) continue;
    if (haversineKm({ lat: order.delivery_lat, lng: order.delivery_lng }, { lat: f.lat, lng: f.lng }) <= radiusKm) return "ok";
  }
  return "no_candidates_within_radius";
}

export function matchFlorists(
  o: MatchOrder,
  florists: MatchFlorist[],
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
  testShopMatching: TestShopMatching = "exclude"
): Candidate[] {
  const w = config.weights;
  const scored = florists
    .filter((f) => passesHardFilter(o, f, testShopMatching, config))
    .map((f) => {
      // Non-null: passesHardFilter already rejected every null distance.
      const d = distanceKm(o, f) as number;
      const emailable = emailIdentifies(f);
      const onboarded = ONBOARDED.includes(f.lifecycle_stage ?? "");
      const breakdown: ScoreBreakdown = {
        onboarded: w.onboarded * (onboarded ? 1 : 0),
        emailable: w.emailable * (emailable ? 1 : 0),
        quality: w.quality * ((f.rating ?? 0) - 3.0 + Math.log10((f.review_count ?? 0) + 1)),
        source: w.source * (SOURCE_SCORE[f.source ?? ""] ?? 0),
        tier: w.tier * (TIER_SCORE[f.trust_tier ?? ""] ?? 0),
        performance: w.performance * performanceTerm(f),
        // Still a within-ring term, not just a bucketing input: it's what keeps
        // the nearer of two otherwise-equal shops ahead, which softens the
        // discontinuity at each ring edge.
        distance: -w.distance * d,
      };
      const score =
        breakdown.onboarded + breakdown.emailable + breakdown.quality +
        breakdown.source + breakdown.tier + breakdown.performance + breakdown.distance;
      return {
        florist_id: f.id, place_id: f.place_id ?? null, source: f.source,
        score, distance_km: d, ring: ringIndex(d, config), breakdown,
        email: emailable ? normalizedEmail(f) : null,
      };
    })
    // Nearest ring first; score breaks it inside a ring. Distance is now the
    // MOST significant key — before, it was the least, behind two boolean tiers
    // that no distance could overcome.
    .sort((a, b) => (a.ring !== b.ring ? a.ring - b.ring : b.score - a.score));

  // Collapse duplicate physical shops. The same storefront can exist as more than
  // one florist row (see MatchFlorist.place_id), so without this the same shop
  // gets offered twice. The list is already best-first, so keeping the first row
  // per place_id keeps each shop's best-ranked record and drops the rest. A null
  // place_id can't prove identity, so those rows are never collapsed.
  const seenPlace = new Set<string>();
  const deduped = scored.filter((c) => {
    if (!c.place_id) return true;
    if (seenPlace.has(c.place_id)) return false;
    seenPlace.add(c.place_id);
    return true;
  });

  // Collapse candidates who would be emailed at the SAME address. Distinct
  // shops, distinct place_ids — but one inbox, so offering all of them sends N
  // copies of "can you deliver in <city>?" to one recipient, each naming a
  // different shop, and the shops that could actually deliver never see it.
  // (Observed 2026-08-06: one Issy-les-Moulineaux order sent four offers to
  // contact@reseau-demo.fr.)
  //
  // Only `emailIdentifies` candidates take part — `c.email` is null for the
  // rest. That is the load-bearing detail: a shop whose address is a known
  // network's is NOT collapsed away, because it is still reachable on its own
  // phone, and the offer path skips only that shop's email leg. Collapsing
  // would throw away a deliverable florist to protect an inbox we already
  // decided not to write to. So this rule is the safety net for addresses we
  // have not yet diagnosed — a fresh ingest before the shared-address sweep
  // runs — and the flags handle the diagnosed ones.
  //
  // The list is already best-first, so keeping the first row per address keeps
  // the strongest candidate for that inbox and drops the rest.
  const seenEmail = new Set<string>();
  const dedupedByEmail = deduped.filter((c) => {
    if (!c.email) return true;
    if (seenEmail.has(c.email)) return false;
    seenEmail.add(c.email);
    return true;
  });

  // topN LAST, after both collapses — trimming earlier could spend the budget on
  // three rows of the same shop, or three shops sharing one inbox.
  return dedupedByEmail.slice(0, config.topN).map((c, i) => ({
    florist_id: c.florist_id, source: c.source, score: c.score,
    distance_km: c.distance_km, ring: c.ring, breakdown: c.breakdown, rank: i + 1,
  }));
}
