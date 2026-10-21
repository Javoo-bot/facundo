# Ingest job queue + Mac-mini poller

**Date:** 2026-07-03
**Status:** Approved (brainstorming) — implementation in progress

## Problem

The dashboard is deployed to Cloudflare Workers at `facundo.example.org`.
Workers cannot spawn OS processes, run Python, or use `node:child_process`. But
both ingest entry points work by spawning the Python CLI on the same machine:

- `POST /api/ingest` → `spawn("uv", ["run", "python", "main.py", ...])`
- `POST /api/keywords` → `spawn(...)` `derive_keywords.py`

On the deployment these are hard-gated to `503` (via `INGEST_ENABLED=false` in
`wrangler.jsonc`). So clicking **Re-run** or **Add city** on the deployed
dashboard fails: the re-run flow first calls `/api/keywords` (→ 503), and even
if it didn't, `/api/ingest` would 503 too.

The user wants ingest to actually run — specifically **on their Mac mini**,
which already has Python, `uv`, the `ingest/` code, and the API keys, and can
reach Supabase outbound.

## Approach: Supabase job queue + Mac-mini poller

The edge doesn't run Python; it **hands the job to the Mac mini** via the
database both sides already share.

1. `POST /api/ingest` on the Worker stops spawning. In queue mode it **inserts
   a `queued` row** into the existing `ingest_jobs` table (via the service-role
   client the dashboard already holds), and returns `{ jobId }`.
2. A long-running poller on the Mac mini (`ingest/poll_jobs.py`) watches for
   `queued` rows, **claims** one (optimistic `queued → running` update), and
   runs the *unchanged* `main.py` pipeline with the row's params. `main.py`
   already writes `running`/progress/`succeeded`/`failed` back to the same row
   (`create_job` upserts on `id`, so it composes with the pre-inserted row).
3. The dashboard already polls `ingest_jobs`, so progress appears with no new
   plumbing — plus a new `queued` badge for the pre-claim window.

Chosen over a direct **Worker → HTTP-to-Mac-mini** call because the queue needs
**no inbound access** to the Mac mini (outbound-to-Supabase only — works behind
NAT, no tunnel, no exposed port, no extra shared secret) and reuses the entire
existing pipeline and job-tracking code.

### Decisions (locked with user)

- **Poller runtime:** launchd agent (auto-start on boot, `KeepAlive` restart),
  not a manually-run command.
- **Keywords on the deployment:** derived on the Mac mini. The Worker enqueues
  with `keywords: null`; `main.py` derives them (it already does when
  `--keywords` is omitted). The Add-city wizard's live keyword *preview* is not
  ported to the edge — acceptable for the POC. `/api/keywords` stays 503 on the
  deployment; nothing calls it there anymore.

## Changes

### 1. Schema — `supabase/migrations/2026-07-03-ingest-queue.sql`

- Drop/recreate `ingest_jobs_status_check` to allow
  `('queued','running','succeeded','failed')`.
- `alter table ingest_jobs add column reset_existing boolean not null default false;`
  (params for the poller; every other run param already has a column).
- No new RLS policy: the Worker writes via service-role (bypasses RLS), the same
  write pattern as `exclude`/`outreach`/`allowlist`.

Also fold these into `supabase/schema.sql` so a fresh setup is correct.

### 2. `dashboard/app/api/ingest/route.ts`

- Introduce `INGEST_MODE` (`"queue"` on the deployment via `wrangler.jsonc`,
  unset/`"spawn"` locally). Replace the `INGEST_ENABLED === "false"` 503 branch:
  - `queue` mode → insert a `queued` `ingest_jobs` row via `createServiceClient()`
    with all params + `reset_existing`; return `{ jobId }`. No spawn.
  - otherwise → existing spawn behavior, unchanged (local dev still works).
- Keep the auth gate. Extend the duplicate guard to reject when a job for
  `(country, city)` is already `status in ('queued','running')`.
- In queue mode allow `keywords` to be `null`/omitted (→ stored `null` →
  derived on the Mac mini). Spawn mode keeps requiring keywords as today.

### 3. Client — queue-aware behavior

- Expose `NEXT_PUBLIC_INGEST_MODE` (build-time) so the client knows the mode.
- `RerunCityButton.tsx`: in queue mode, **skip the `/api/keywords` prefetch**
  and POST `/api/ingest` with `keywords: null`.
- `AddCityForm.tsx`: in queue mode, don't auto-fetch keywords and **allow submit
  with zero keywords** (enqueue `null`; keywords derived on the Mac mini). Show a
  short note that keywords are derived server-side.
- Jobs UI: render a `queued` status badge/label.

### 4. `ingest/poll_jobs.py` (new) + launchd

- Service-role Supabase client (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
  same env `main.py` requires).
- Loop (sleep ~3–5s between passes):
  1. Select oldest `status='queued'` row.
  2. Optimistically claim: `update ... set status='running' where id=? and
     status='queued'`; proceed only if it affected the row (single poller, but
     safe regardless).
  3. Run `uv run python main.py --job-id <id> --country <c> --city <city>
     --radius <r> --limit <n> [--keywords <csv> --language <l>]
     [--reset-existing]`. Omit `--keywords` when the row's keywords are null so
     `main.py` derives. Wait for completion; `main.py` writes the terminal
     status.
  4. On unexpected poller-side failure before/around the run, mark the row
     `failed` with an error so it doesn't wedge as `running` forever.
- launchd: `com.facundo.ingest-poller.plist` template + `launchctl` load
  instructions; `WorkingDirectory` = `ingest/`, `KeepAlive=true`,
  `RunAtLoad=true`, env from the same `.env` the CLI uses.

### 5. Config + docs

- `wrangler.jsonc`: replace `INGEST_ENABLED=false` with `INGEST_MODE=queue`
  (and note `NEXT_PUBLIC_INGEST_MODE=queue` is a build-time var supplied like
  the other `NEXT_PUBLIC_*` values).
- `DEPLOY.md` §6: rewrite "Ingest is local-only" to describe the queue model and
  point at the poller setup.
- Poller setup doc (`ingest/POLLER.md` or a README section): env, launchd
  install, how to verify.

## Verification

1. **Enqueue:** in queue mode, `POST /api/ingest` (or a re-run click) → a
   `queued` row appears in `ingest_jobs` with the right params; no process
   spawned.
2. **Poller:** run `poll_jobs.py` against a `queued` row → row transitions
   `queued → running → succeeded`, florists land, count is idempotent on
   re-run. A second poller pass with no queued rows is a no-op.
3. **End-to-end:** with the poller live on the Mac mini, re-run Sitges from
   `facundo.example.org` → job runs on the Mac mini, dashboard shows
   progress, data updates.
4. `npm run build` / typecheck passes; existing scoring sanity test still
   passes.

## Non-goals

- No inbound service / tunnel to the Mac mini.
- No porting the Python pipeline (Apify, scraping, Claude, Nominatim) to the
  edge.
- No live keyword preview on the deployment.
- No multi-worker/distributed queue semantics — one poller, optimistic single
  claim is sufficient for the POC.
