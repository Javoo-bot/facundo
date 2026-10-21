-- Manually adding a florist we already work with, and sending them a join link.
-- See docs/superpowers/specs/2026-08-12-manual-florist-join-link-design.md.
--
-- Two columns, both additive with defaults, so existing rows are untouched.

-- 1. Cities created to hold a manual partner, rather than by an Apify scrape.
--
-- `cities.ingested_at` is `not null default now()`, so a city created for a
-- hand-added florist would otherwise claim a scrape that never happened — the
-- overview renders it as "Last ingested <timestamp>"
-- (components/DashboardClient.tsx). This column lets that label tell the truth.
--
-- It is also a work queue, not just hygiene: a city holding manual partners
-- with no scrape behind it is a city worth scraping.
alter table cities add column if not exists source text
  check (source in ('ingest', 'manual')) default 'ingest';

comment on column cities.source is
  'How this city row came to exist. ''ingest'' = created by an Apify scrape (the default, and true of every row predating this column). ''manual'' = created to hold a hand-added partner florist whose location no existing city covers; nothing has been scraped here, so ingested_at is a creation timestamp rather than a scrape time.';

-- 2. Who vouched for a hand-added florist.
--
-- `florists.source` already distinguishes 'existing' | 'known' | 'new', but not
-- WHO decided. For rows a human vouched for — the whole premise of 'existing' —
-- that is the fact you want months later when a partner underperforms. Staff
-- email, matching the `created_by` convention on order_issues.
alter table florists add column if not exists added_by text;

comment on column florists.added_by is
  'Staff email of whoever created this florist by hand (app/api/florists/create). Null for every ingest-created row, which is all of them before 2026-08-12.';
