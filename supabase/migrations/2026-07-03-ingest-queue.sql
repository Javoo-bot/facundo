-- Migration: turn ingest_jobs into a work queue for the Mac-mini poller.
--
-- The dashboard now runs on Cloudflare Workers, which cannot spawn the Python
-- ingest CLI. Instead POST /api/ingest (in queue mode) inserts a `queued` row
-- here via the service-role client, and ingest/poll_jobs.py on the Mac mini
-- claims it (queued -> running) and runs main.py. So `status` gains a `queued`
-- state, and we persist `reset_existing` (the one run param that previously
-- lived only in the CLI's spawn args) so the poller can reconstruct the
-- --reset-existing flag. Every other run param already has a column.
--
-- Safe to run once on a project already created from schema.sql. Existing rows
-- keep their status; the new column defaults to false.

alter table ingest_jobs
  add column if not exists reset_existing boolean not null default false;

-- Widen the status check to allow the pre-claim `queued` state. Drop-and-add is
-- idempotent-friendly: the constraint name is stable, so re-running replaces it.
alter table ingest_jobs drop constraint if exists ingest_jobs_status_check;
alter table ingest_jobs
  add constraint ingest_jobs_status_check
  check (status in ('queued', 'running', 'succeeded', 'failed'));
