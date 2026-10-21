# Background ingest with visibility (feature #1)

Date: 2026-07-02. Make ingestion run to completion in the background (independent of
the dialog/tab) with user-visible status + progress.

## Problem
`/api/ingest` streams SSE and kills the child on client disconnect, so closing the
Add-city dialog or navigating away cancels the ingest.

## Architecture (CLI owns the job record — no service-role key in the dashboard)

- **`ingest_jobs` table** (Supabase): `id uuid pk default gen_random_uuid()`,
  `country text`, `city text`, `radius_km double precision`, `limit_per_keyword int`,
  `keywords jsonb`, `language text`, `status text not null` (running | succeeded |
  failed), `last_line text`, `log text` (accumulated progress), `error text`,
  `started_at timestamptz default now()`, `finished_at timestamptz`. RLS enabled;
  **select** policy `to authenticated using (public.is_email_allowed())` so the jobs
  panel can read it; **no insert/update policy** — only the service role (the CLI)
  writes it. Migration + schema.sql.
- **`/api/ingest` route** → fire-and-forget: auth-gate (session + `isAllowed`),
  validate the same body as today, generate a job UUID, spawn
  `uv run python main.py --job-id <uuid> --country … --city … --radius … --limit …
  --keywords … --language …` **detached** (`{ detached: true }` + `child.unref()`, and
  do NOT kill on `request.signal` abort), return `{ jobId }` JSON. No SSE.
- **`main.py --job-id`** (new optional flag): when present, uses its existing
  service-role Supabase client to (a) upsert the `ingest_jobs` row to `running` at
  start (with the params), (b) update `last_line` + append `log` on each `[N/7]` step,
  (c) set `status=succeeded`/`failed` + `finished_at` (+ `error`) at the end, wrapping
  the whole run so a crash records `failed`. Without `--job-id`, behaves exactly as
  today (terminal use, no job row). A small `ingest/jobs.py` helper holds the writes.
- **`/api/jobs` route** (GET, auth-gated): returns recent `ingest_jobs` (RLS-scoped
  via the user client), most-recent first, small limit. The panel polls it (~2s).

## Visibility UI (dashboard)
- **Header jobs indicator**: a button showing the count of `running` jobs (polls
  `/api/jobs`); pulses/spins while any run. Click → opens the **jobs drawer**.
- **Jobs drawer** (right-side panel): list of recent jobs — city + country, status
  (spinner / ✓ / ✗), `last_line` progress, started time; running jobs update live via
  polling. When a job flips running → succeeded, fire a toast and `router.refresh()`
  so the new/updated city appears in the overview.
- **Add-city wizard**: on *Ingest* (step 3) → `POST /api/ingest` → `{ jobId }` → show a
  brief "Started — running in the background" confirmation → Done closes the dialog.
  The header indicator now shows the running job. (Removes the inline SSE streaming
  log from the wizard.)
- **Re-run** (overview row ↻ and `/city/[id]`): same fire-and-forget → job appears in
  the panel. `RerunToast`/`useIngestStream` are replaced by the job-start + panel model
  (delete or repurpose the SSE hook).

## Safety
- Prevent a duplicate concurrent ingest of the same (country, city): the route checks
  for an existing `running` job for that city and rejects with a clear message (or the
  UI disables re-run while one is running).
- Old finished jobs accumulate (small table, fine for POC); the panel shows the recent
  N.

## Build split
- **backend-engineer:** `supabase/` (`ingest_jobs` table + migration + RLS),
  `ingest/main.py` (`--job-id` lifecycle writes), `ingest/jobs.py` helper.
- **frontend-engineer:** `dashboard/` — rewrite `/api/ingest` (fire-and-forget +
  detached spawn), new `/api/jobs` (GET), header jobs indicator + jobs drawer
  (polling), update the wizard + re-run flows to the job model, retire the SSE
  streaming.

## Non-goals
No websockets/Realtime (polling is fine at POC scale). No job cancellation UI (a
started ingest runs to completion). No multi-server/queue infra.
