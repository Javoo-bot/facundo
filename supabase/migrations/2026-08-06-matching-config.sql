-- Matching: distance rings, a real ceiling, and runtime-tunable knobs.
-- See docs/superpowers/specs/2026-08-06-matching-rings-and-config-design.md.
--
-- Three things happen here:
--   1. every matching constant moves out of code and into app_settings;
--   2. florists gain a (lat, lng) index, because candidates are now loaded by a
--      bounding box around the delivery point instead of by city_id;
--   3. the 5,820 florists with no trust_tier get one, because a florist without
--      a tier cannot be paid and so was silently unmatchable.

-- ---------------------------------------------------------------------------
-- 1. MatchConfig (dashboard/lib/match.ts::MatchConfig). Every default here
--    matches DEFAULT_MATCH_CONFIG exactly — the loaders fall back to the
--    compiled defaults per-field, so a row predating this migration and a row
--    written by it must behave identically.
-- ---------------------------------------------------------------------------

-- Ascending km boundaries. Candidates sort by which ring they fall in BEFORE
-- score is considered, so this is the primary lever on who gets an offer. The
-- last edge is also the hard cap: nothing beyond it is ever offered, however
-- large a radius the shop itself claims.
alter table app_settings add column if not exists match_ring_edges_km numeric[] not null default '{5,10,20}';

-- Within-ring score weights. `distance` is subtracted; the rest are added.
alter table app_settings add column if not exists match_weight_distance    numeric not null default 0.25;
-- Larger than source:existing (1.2 x 2 = 2.4) on purpose — before rings,
-- onboarded-vs-not was a hard sort tier no score could overturn. Keeping it the
-- biggest single bonus preserves that effect inside a ring.
alter table app_settings add column if not exists match_weight_onboarded   numeric not null default 3.0;
alter table app_settings add column if not exists match_weight_emailable   numeric not null default 1.5;
alter table app_settings add column if not exists match_weight_quality     numeric not null default 1.0;
alter table app_settings add column if not exists match_weight_source      numeric not null default 1.2;
alter table app_settings add column if not exists match_weight_tier        numeric not null default 1.0;
alter table app_settings add column if not exists match_weight_performance numeric not null default 0.4;

-- How many candidates a match writes. Was a hardcoded 3 in two places.
alter table app_settings add column if not exists match_top_n integer not null default 3;

-- Quality floors. NULL = no floor (not "floor of zero").
alter table app_settings add column if not exists match_min_rating       numeric;
alter table app_settings add column if not exists match_min_review_count integer;
-- Does a florist with NO rating pass match_min_rating? Unrated is not the same
-- as bad — a fresh ingest often has no rating yet — so this defaults to true.
alter table app_settings add column if not exists match_allow_unrated boolean not null default true;
alter table app_settings add column if not exists match_exclude_tier4 boolean not null default false;
-- A florist with no trust_tier cannot be paid (lib/payout.ts resolves the
-- accept/delivery split from trust_tiers by that code), so this defaults to
-- true. Turning it off is a deliberate recruiting-run choice, exposed only in
-- the per-order "Find florists" panel.
alter table app_settings add column if not exists match_require_trust_tier boolean not null default true;

-- ---------------------------------------------------------------------------
-- 2. Geographic candidate loading.
--
-- Matching used to load florists by city_id, where city_id came from an exact
-- ilike on the delivery address's city name. An order in an uncovered suburb
-- therefore matched NOBODY even with ten of our florists 3km away, and an order
-- near a city edge could not reach a florist in the next city's ingest. Now
-- that a hard cap exists, the cap is the boundary and city membership is only
-- reporting metadata.
--
-- A plain btree on (lat, lng) is enough at this scale (5.8k rows): the leading
-- column carries the latitude range and the longitude range is filtered from
-- the same index entries. PostGIS would be the answer at a much larger size.
-- ---------------------------------------------------------------------------
create index if not exists florists_lat_lng_idx on florists (lat, lng);

-- ---------------------------------------------------------------------------
-- 3. Trust-tier backfill.
--
-- Measured 2026-08-06: 5,820 of 5,829 matchable florists had trust_tier NULL,
-- so the worker's hard filter (which requires one, because there is otherwise
-- no payout split to apply) could reach only 9 shops across 53 cities.
--
-- Backfilled to '2' (Known: 70% on accept, 30% on delivery, photo required,
-- €500 exposure cap). NOTE: tier 2 pays the majority BEFORE a delivery photo
-- exists. Tier 3 (New) is the zero-until-photo alternative and was the
-- conservative option; 2 was chosen deliberately. The exposure cap and photo
-- requirement still apply either way.
update florists set trust_tier = '2' where trust_tier is null;

-- New ingests land tiered rather than silently unmatchable.
alter table florists alter column trust_tier set default '2';
