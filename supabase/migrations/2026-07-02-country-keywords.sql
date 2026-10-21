-- Migration: cache of localized florist search keywords + Google Maps
-- language per country (derived by ingest/keywords.py via Claude, consumed
-- by ingest/main.py and ingest/derive_keywords.py). Safe to run once on a
-- project already created from the original schema.sql.
--
-- Same pattern as `allowed_emails`: RLS enabled, NO policies — unreadable/
-- unwritable by anon and authenticated roles; only the service-role ingest
-- pipeline (which bypasses RLS) manages this cache.

create table if not exists country_keywords (
  country     text primary key,
  keywords    jsonb not null,
  language    text,
  updated_at  timestamptz not null default now()
);

alter table country_keywords enable row level security;
-- No policies: service-role only. See supabase/schema.sql for the full note.
