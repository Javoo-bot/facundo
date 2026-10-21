-- Enrichment repair mode — an ingest job that re-runs enrichment against rows
-- ALREADY in the table, with no Apify scrape.
--
-- Why it exists: on 2026-08-06 the Anthropic account ran dry mid-ingest. The
-- crawl kept working (5-8 pages per florist, contact pages included) but every
-- LLM extraction leg returned 400 "credit balance is too low", so the rows
-- landed with email/phone_web/owner_name all null and the error recorded in
-- enrichment_notes. The OpenRouter migration fixed the pipeline going forward;
-- it did not repair what was already written. 1,732 live florists across 60
-- cities have a website, no email, and a recorded enrichment failure — every
-- one an order we can only reach by SMS (see order #2000027: 25 offers, 24 of
-- them email-skipped as `florist-no-email`).
--
-- Nothing about the repair needs Apify: the pages are still on the web and the
-- failure was downstream of the scrape. So this is a MODE on the existing job
-- rather than a new table or a new worker — the cron claim, the queue, the
-- progress log, cost accounting and the /jobs page then all work unchanged.
--
-- 'city' is the default so every existing row keeps its current meaning and
-- ingest-worker/src/index.ts can treat a missing value as a normal ingest.
alter table ingest_jobs
  add column if not exists mode text not null default 'city';

alter table ingest_jobs
  drop constraint if exists ingest_jobs_mode_check;
alter table ingest_jobs
  add constraint ingest_jobs_mode_check check (mode in ('city', 'repair'));

comment on column ingest_jobs.mode is
  'city = full ingest (geocode -> keywords -> Apify -> relevance -> enrich). repair = re-enrich rows already in `florists` for this city, no Apify run and nothing billed there; see ingest-worker/src/workflow.ts and docs/superpowers/specs/2026-08-11-enrichment-repair-mode-design.md.';

-- The repair job selects on (city_id, email is null, deleted_at is null) and
-- then filters on enrichment_notes. Without this a 6,800-row table gets a
-- sequential scan per city job, 60 times over.
create index if not exists florists_repair_targets_idx
  on florists (city_id)
  where email is null and deleted_at is null and excluded_at is null;
