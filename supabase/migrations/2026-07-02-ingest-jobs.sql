-- Migration: background-job tracking for ingest runs kicked off from the
-- dashboard. `id` is normally supplied by the caller (a UUID minted by the
-- dashboard when it starts a run) — ingest/main.py upserts on that exact id
-- via `--job-id`; the default below is only a fallback for manual testing.
-- Safe to run once on a project already created from the original schema.sql.
--
-- Readable by allow-listed dashboard users (like `cities`/`florists`), but
-- with NO insert/update policy — only the service-role ingest CLI (which
-- bypasses RLS) writes to this table, same write pattern as
-- `country_keywords`.

create table if not exists ingest_jobs (
  id                 uuid primary key default gen_random_uuid(),
  country            text not null,
  city               text not null,
  radius_km          double precision,
  limit_per_keyword  integer,
  keywords           jsonb,
  language           text,
  status             text not null,          -- 'running' | 'succeeded' | 'failed'
  last_line          text,                   -- most recent progress line, for a compact status display
  log                text,                   -- bounded tail of progress lines (see ingest/jobs.py)
  error              text,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  constraint ingest_jobs_status_check check (status in ('running', 'succeeded', 'failed'))
);

alter table ingest_jobs enable row level security;
create policy "allowlisted read ingest_jobs" on ingest_jobs for select to authenticated using (public.is_email_allowed());
