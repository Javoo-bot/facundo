# Matching: distance rings, a real ceiling, and knobs you can turn

**Date:** 2026-08-06
**Status:** approved, ready to implement

## Why

Three complaints, one root cause.

Distance barely affects who gets an offer. `matchFlorists` sorts
lexicographically — onboarded-vs-not, then emailable-vs-not, then score — so a
40km onboarded shop always beats a 2km prospect, and no weight tuning can change
that. Inside a bucket the distance weight is 0.25/km, which loses to a
`source: existing` bonus until the nearer shop is ~10km closer.

There is no ceiling of our own. The only distance bound is each florist's
self-declared `delivery_radius_km`, so a shop that typed "50" gets offered a 48km
order.

Nothing is tunable at runtime. Weights are compile-time constants in two files,
and `topN` is a hardcoded `3` in two more.

### What the data says

Measured against production on 2026-08-06:

| | count |
|---|---|
| florists, not deleted | 5,829 |
| matchable lifecycle stage | 5,829 |
| `delivery_radius_km IS NULL` | 5,816 |
| `trust_tier IS NULL` | 5,820 |
| `lat/lng IS NULL` | 0 |
| **pass the worker's hard filter** | **9** |

The worker's automatic matcher can reach nine shops across 53 cities. The
dashboard's re-match copy — which is missing the null-radius and null-tier guards
— is the only path reaching the other ~5,800. That divergence is not a design; it
is drift, and it is load-bearing today.

## Decisions

Recorded with their alternatives, because several are close calls.

### Distance rings, not a bigger distance weight

Sort by ring index first, then by score. Ring edges are the tunable knob.

Rejected: folding everything into one score (every knob live, but "nearest first"
stops being literally true and the weights need constant balancing); keeping
onboarded as a hard tier (leaves the exact complaint — a far onboarded shop
beating a near prospect — unfixed).

The known cost is a cliff at every edge: a 4.9km tier-4 shop outranks a 5.1km
onboarded star. Mitigated by coarse default rings and by keeping a distance term
*inside* the score, so within a ring the nearer of two equals still wins.

### A global cap that floors the florist's radius

One `match_max_distance_km`, and effective limit = `min(cap, radius ?? cap)`.

Rejected: per-city caps (accurate, but every new city needs a decision and 53
rows need maintaining) and global-with-per-city-override (same, deferred until
one city actually needs it).

### Null `delivery_radius_km` no longer rejects

The radius gate existed to stop an unlocatable florist receiving an order. The
cap now provides that bound, and 5,816 florists have no radius. So null means
"use the cap" rather than "reject".

### Null `trust_tier` still rejects, by default — and the data gets fixed

`lib/payout.ts` looks up `trust_tiers` by code to get the accept/delivery split,
so an untiered florist genuinely cannot be paid. Kept as `requireTrustTier`,
defaulting to `true`.

This **tightens the dashboard re-match path**, which has no tier gate today and
can therefore send a real order to an unpayable shop. The manual panel exposes
the toggle so a deliberate recruiting run can loosen it, visibly.

Leaving 5,820 florists untiered would make that gate strand nearly everyone, so
the migration backfills them to tier **2** ("Known": 70% on accept, 30% on
delivery, photo required, €500 exposure cap) and sets it as the column default.

Tier 3 ("New": 0% on accept, 100% on delivery) was the conservative option and
was not chosen. Tier 2 releases the majority of the payout **before** a delivery
photo exists, for shops we have never worked with. The exposure cap and photo
requirement still apply. Recorded here because it is the one decision in this
change that can lose money rather than just mis-rank.

### Unknown distance now excludes

Today a null `delivery_lat/lng` means every florist clears the radius check and
scores distance-0 — silently. An order we cannot locate escalates to CX instead.

### Geographic candidate loading

Load by bounding box around the delivery point, sized to the cap. Drop the
`city_id` filter.

`city_id` comes from an exact `ilike` on the delivery address's city name, so an
order in an uncovered suburb gets zero candidates even with ten of our florists
3km away, and an order near a city edge cannot reach a florist in the next city's
ingest. Once a cap exists, the cap *is* the boundary. `city_id` stays on the
order for reporting.

### One canonical file

`dashboard/lib/match.ts` becomes canonical and fully self-contained (no imports).
`ingest-worker/src/match.ts` becomes a byte-identical generated copy.

The two copies have already drifted three ways (performance term, capacity
filter, null-radius/null-tier guards) and the existing regex lockstep guards
caught none of it. Config flowing in from the DB makes that worse.

## Design

### `MatchConfig`

```ts
export interface MatchConfig {
  ringEdgesKm: number[];   // ascending; the LAST edge is the hard cap
  weights: {
    distance: number; onboarded: number; emailable: number;
    quality: number; source: number; tier: number; performance: number;
  };
  topN: number;
  minRating: number | null;       // null = no floor
  minReviewCount: number | null;  // null = no floor
  allowUnrated: boolean;          // does a null rating pass the floor?
  excludeTier4: boolean;
  requireTrustTier: boolean;
}
```

Defaults — chosen so that within a ring, today's ordering broadly survives:

```
ringEdgesKm      [5, 10, 20]
distance         0.25    onboarded    3.0     emailable   1.5
quality          1.0     source       1.2     tier        1.0
performance      0.4
topN             3
minRating        null    minReviewCount  null
allowUnrated     true    excludeTier4    false
requireTrustTier true
```

`onboarded` at 3.0 outweighs `source: existing` (+2.4), preserving the practical
effect of today's first sort tier inside each ring.

`loadMatchConfig(sb)` reads `app_settings` and falls back to the compiled
defaults **per field** on any read error, null, or malformed value. A bad
settings row degrades to known-good behavior rather than matching nothing.
Validation: `ringEdgesKm` must be non-empty, all finite, all > 0, strictly
ascending — otherwise the whole array falls back to the default.

### Hard filters

In order. The test-shop gate stays first so nothing can let one through.

1. test-shop gate (`exclude` default / `only`)
2. `excluded_at` denylist
3. `lifecycle_stage ∈ MATCHABLE`
4. `trust_tier` non-null — skipped when `requireTrustTier` is false
5. quality floor — `rating`, `review_count`, tier-4
6. **distance known, and `d ≤ min(cap, radius ?? cap)`**
7. `capacity_per_day` vs `accepted_count_for_day`

Null-safety on the quality floor: a null `rating` passes when `allowUnrated` is
true and fails otherwise; a null `review_count` is treated as 0 against
`minReviewCount`. Never `NaN`.

### Ranking

```
sort by:  1. ring(d)  — index of the first edge where d ≤ edge
          2. score desc

score = w.onboarded   × (onboarded ? 1 : 0)
      + w.emailable   × (emailIdentifies ? 1 : 0)
      + w.quality     × (rating − 3.0 + log10(reviews + 1))
      + w.source      × SOURCE_SCORE
      + w.tier        × TIER_SCORE
      + w.performance × performanceTerm
      − w.distance    × d
```

Both dedupes (`place_id`, then normalized email) are unchanged and still run
after sorting, so the best-ranked record survives each collapse. `.slice(0,
topN)` moves *into* `matchFlorists` from its two call sites, making the count one
knob rather than two constants.

`matchFlorists` returns `ring` and a per-term `breakdown` alongside each
candidate, so the manual panel can explain a ranking without recomputing it.

### Geographic loading

`loadMatchableFlorists(sb, { lat, lng, capKm })`:

- bounding box: `±capKm/111.32` degrees latitude,
  `±capKm/(111.32·cos(lat))` degrees longitude
- plus `lat/lng not null`, `deleted_at is null`, `excluded_at is null`,
  `lifecycle_stage in MATCHABLE`
- exact haversine in `matchFlorists` then trims the box corners

Requires an index on `florists (lat, lng)`.

The longitude delta is clamped to 180° so a `cos(lat) → 0` near the poles cannot
produce an infinite span. Antimeridian wraparound is *not* handled — no covered
city is near it, and a bounding box that crosses ±180 would silently return
nothing rather than wrong rows. Documented, not fixed.

Order with no `delivery_lat/lng` → empty list → escalate.

### Config plumbing

`matchFlorists(order, florists, config, testShopMatching)` — `config` replaces
the old `weights` parameter. Both callers (`lateMatch.ts::matchAndWriteCandidates`,
`api/orders/rematch`) load config first and pass it through.

### Settings

New `app_settings` columns, one per knob, with the defaults above. A "Matching"
section added to the existing `MatchingPanel.tsx`, following the established
`SettingsForm` / `initialForm` / `/api/settings` validation pattern. Ring edges
edit as a comma-separated string (like `activeOrderTagsText`) and parse on save.

### Manual panel

"Find florists" on the order page opens a panel pre-filled from saved settings.
`POST /api/orders/rematch/preview` ranks without writing and returns each
candidate's ring and score breakdown; adjust, then commit through the existing
`POST /api/orders/rematch`, which accepts an optional `config` override.
Overrides are per-run — saved settings are untouched.

### Ingest on empty

When matching returns zero candidates:

1. escalate to CX immediately — never block an order on a multi-minute job
2. queue a `CityIngestWorkflow` for the delivery area at `radius = cap`, by
   inserting an `ingest_jobs` row (`country`, `city`, `radius_km`) the way
   `/api/ingest` already does
3. on success, re-run the match and append fresh candidates

Mode-gated: fires unattended in `auto`; in `semi` the request rides on the
escalate approval's `queue_ingest` payload, so approving the escalation
authorises the spend; never in `manual`.

> Corrected during implementation. The plan said `semi` would file its own
> pending `ingest` approval. It can't: `order_approvals` has a unique index
> allowing one pending row per order, and the escalation already holds it.
> Attaching the request to the escalate approval keeps one decision for the
> operator and needs no new approval kind.

**Idempotency** (correctness, not policy): skip if an ingest for that
country+city is already `queued` or `running`, reusing `/api/ingest`'s existing
duplicate guard, and skip if one already completed for that area. Without it, ten
orders in one uncovered town fire ten concurrent Apify runs for identical data.

No cooldown, no budget cap, no order-value gate — deliberately out of scope.

### `lib/lifecycle.ts`

Updated in the same change: the match stage's description rewritten for rings,
cap, and config; `code` refs updated; new branches for *order didn't geocode →
escalate*, *nothing in range → escalate + ingest*, and *ingest found nothing*.

## Testing

Unit (`node --test`, the existing lightweight convention):

- ring assignment, including exactly-on-edge values
- cap floors a larger declared radius; a smaller declared radius still wins
- null radius uses the cap rather than rejecting
- null distance excludes
- quality floors, including null rating under both `allowUnrated` settings
- `requireTrustTier` both ways
- `loadMatchConfig` per-field fallback on malformed rows
- `topN` applied after both dedupes
- byte-equality of the two `match.ts` files

Manual: a real re-match on a live order through the preview panel; a forced
zero-candidate order to exercise the ingest branch.

### What verification actually found (2026-08-06)

Run against production data over the 120 most recent orders:

| | |
|---|---|
| orders with no `city_id` resolved | 116 / 120 |
| orders that matched **nobody** before | **120 / 120** |
| orders that match after geographic loading + tier backfill | 20 |
| still empty — genuinely uncovered areas | 100 |

Order #2000023 (Athens) sat escalated with **185 of our florists inside 20km**,
because the delivery city read "ATHINA" and the `cities` row says "Athens". The
100 that remain empty are real coverage gaps — Wehrheim, Zellhausen, Düren,
Tarifa, Silgueiros — which is exactly the population the ingest-on-empty path
exists for.

Confirmed in a browser on the live dashboard: the panel reported "185 florists
within 20km · 0 passed the filters" with the tier gate on, and ranked all 185
with rings and score breakdowns with it off — the same three shops and the same
scores (5.60 / 5.44 / 5.40) the offline run produced.

## Risks

**Rings change who gets offered, not just the ordering.** A 3km cold prospect
will outrank a 12km onboarded shop that reliably delivers. Expect more orders
routed to shops that have never accepted one.

**The 20km cap escalates orders that today get offered** — though with 5,816
florists having no radius at all, the cap mostly *widens* reach rather than
narrowing it.

**The tier gate tightens the manual path.** Re-match currently reaches ~5,820
florists; with `requireTrustTier` on it reaches ~9. This is the correct default
(those shops cannot be paid), but it will look like a regression until the toggle
is understood. Worth assigning tiers in bulk before relying on the auto path.

## Out of scope

Drive-time distance (crow-flies retained), per-city caps, ingest cooldown/budget
caps, order-value gating, backfilling `trust_tier`/`delivery_radius_km`, and
merging the duplicate florist rows the `place_id` dedupe masks.
