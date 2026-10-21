-- Same-named cities across different regions were colliding. Order
-- #2000031 delivers to San Carlos, Balears (Ibiza) — but the "Scrape this
-- area" button and the automatic ingest-on-empty path both name the geocode
-- target from delivery_address.city + .country alone ("San Carlos, ES"),
-- which Nominatim resolved to its single best-ranked match: a same-named
-- village in Castilla y León, ~900km away. That result was then cached
-- forever under the (country, city) key in `cities`, so every future order
-- to the real San Carlos kept finding 0 florists within range.
--
-- This gives callers a region hint to disambiguate the geocode query, and a
-- reference point to sanity-check the geocoded result against, instead of
-- trusting Nominatim's top match blindly. See ingest/geocode.py,
-- ingest/db.py::get_or_create_city, and their ingest-worker/src TS mirrors.

-- NOT NULL DEFAULT '' (not nullable) so every caller — Python and TS alike —
-- can filter/insert on this column as a plain string equality, never a NULL
-- comparison (PostgREST's `.eq(col, null)` is a footgun best avoided).
-- '' means "no region hint", same convention as the widened `cities.region`
-- below.
alter table ingest_jobs add column if not exists region text not null default '';
-- The order's own delivery_lat/delivery_lng (or equivalent), so the pipeline
-- can refuse a geocode result that lands implausibly far from where the
-- request actually meant, rather than silently caching a wrong city. These
-- two stay nullable — "no reference point" is a real, common case (a manual
-- CLI run has no order to anchor to), and there's no sentinel float for that.
alter table ingest_jobs add column if not exists near_lat double precision;
alter table ingest_jobs add column if not exists near_lng double precision;

comment on column ingest_jobs.region is
  'Administrative region/state hint (e.g. "Balears"), appended to the Nominatim query to disambiguate same-named cities, and part of the idempotency key alongside (country, city). '''' = no hint available.';
comment on column ingest_jobs.near_lat is
  'Reference latitude the geocoded city center is sanity-checked against (see ingest/geocode.py::MAX_GEOCODE_DRIFT_KM). Null = no check performed.';
comment on column ingest_jobs.near_lng is
  'Reference longitude paired with near_lat.';

-- Widen the `cities` cache key to include region, so "San Carlos, Balears"
-- and "San Carlos, Castilla y León" become two distinct rows instead of one
-- colliding on (country, city). Normalize existing NULLs to '' first:
-- Postgres treats NULL <> NULL, so a unique(country, city, region)
-- constraint would otherwise silently allow duplicate blank-region rows
-- rather than actually enforcing uniqueness for cities ingested before
-- region-backfill existed (19 of 88 as of 2026-08-25).
update cities set region = '' where region is null;
alter table cities alter column region set default '';
alter table cities alter column region set not null;

alter table cities drop constraint if exists cities_country_city_key;
alter table cities add constraint cities_country_city_region_key unique (country, city, region);
