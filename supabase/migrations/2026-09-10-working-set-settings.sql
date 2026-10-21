-- Working-set criteria: replaces the tag-only opt-in gate (2026-07-26-active-
-- order-tags.sql) with an explicit predicate — see dashboard/lib/orderTags.ts
-- + ingest-worker/src/tags.ts::isInWorkingSet, the single source of truth.
--
-- Semantics (all three settings combine via OR, `run_all_orders` short-circuits):
--   - run_all_orders = true            -> every order is in the working set.
--   - active_order_tags OR
--     active_order_countries non-empty -> an order is in the working set if its
--                                          Shopify tags intersect active_order_tags
--                                          OR its delivery country (the Shopify
--                                          shipping country code) is in
--                                          active_order_countries.
--   - all three empty/false            -> NO order is in the working set. This is
--                                          the safe default: empty criteria must
--                                          never silently mean "match everything"
--                                          (that used to be active_order_tags'
--                                          empty-array behavior; it no longer is).
--
-- active_order_tags itself is untouched by this migration — only its
-- empty-means-match-everything behavior changes, in application code, not schema.
alter table app_settings
  add column if not exists active_order_countries text[] not null default '{}',
  add column if not exists run_all_orders boolean not null default false,
  add column if not exists working_set_radius_km double precision not null default 5;

comment on column app_settings.active_order_countries is
  'Working-set criterion: delivery-country allow-list (Shopify shipping country codes, e.g. ES, FR). Combines with active_order_tags via OR. Empty = no country criterion (see isInWorkingSet).';

comment on column app_settings.run_all_orders is
  'Explicit "run every order through the system" switch. true short-circuits active_order_tags/active_order_countries entirely. Default false — empty criteria must stay safe (no orders), never implicitly "all orders".';

comment on column app_settings.working_set_radius_km is
  'Search radius (km) from an order''s delivery coordinates used to decide whether the existing florist pool has usable candidates on working-set entry. Below this, ingest is requested instead of silently escalating (see ingest-worker/src/lateMatch.ts::matchAndWriteCandidates + db.ts::requestCandidateIngest). Default 5, editable in Settings.';
