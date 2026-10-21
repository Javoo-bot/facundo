# Ingest queue poller (Mac mini)

The dashboard is deployed to Cloudflare Workers, which **cannot run the Python
ingest CLI** (no Python, no `uv`, no `child_process`). So on the deployment
(`INGEST_MODE=queue`), clicking **Re-run** or **Add city** doesn't run ingest
directly — it inserts a `queued` row into the `ingest_jobs` table.

`poll_jobs.py` runs here on the Mac mini, watches for those `queued` rows,
claims each one (`queued → running`), and runs the normal `main.py` pipeline
with the row's params. `main.py` writes all progress/cost/terminal status back
to the same row, so the dashboard's jobs panel shows it live — exactly as it did
when ingest was spawned locally.

**Net effect:** as long as this poller is running on the Mac mini, ingest
triggered from `facundo.example.org` "just works" — jobs are picked up within
a few seconds and run locally, against the same Supabase project.

## Prerequisites

Same as the ingest CLI itself: `uv sync` has been run in `ingest/`, and a
`.env` file exists here with at least:

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
APIFY_TOKEN=...
OPENROUTER_API_KEY=...
```

(The poller only needs the two `SUPABASE_*` vars to claim jobs, but the
`main.py` run it launches needs all four — so set them all.)

## Run it manually (to test)

```bash
cd ingest
uv run python poll_jobs.py
```

You should see `watching ingest_jobs for queued runs…`. Trigger a re-run from
the deployed dashboard (or insert a `queued` row) and watch it claim and run.
`Ctrl-C` to stop. Poll interval defaults to 4s; override with
`POLLER_INTERVAL_S=10 uv run python poll_jobs.py`.

## Install as a launchd agent (auto-start on login, restart on crash)

1. Find the three values the template needs:

   ```bash
   which uv          # -> {{UV_PATH}}
   pwd               # from ingest/  -> {{INGEST_DIR}}
   echo "$PATH"      # -> {{PATH}}
   ```

2. Copy the template and fill in those placeholders:

   ```bash
   cp com.facundo.ingest-poller.plist.example \
      ~/Library/LaunchAgents/com.facundo.ingest-poller.plist
   # then edit the file and replace {{UV_PATH}}, {{INGEST_DIR}}, {{PATH}}
   ```

3. Load it:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.facundo.ingest-poller.plist
   ```

It now starts at login and restarts if it crashes (`KeepAlive`). Logs:

```bash
tail -f /tmp/facundo-ingest-poller.out.log
tail -f /tmp/facundo-ingest-poller.err.log
```

To stop / uninstall:

```bash
launchctl unload ~/Library/LaunchAgents/com.facundo.ingest-poller.plist
```

## Notes

- **One poller at a time.** The claim step is optimistic
  (`update … where status='queued'`), so a stray second poller can't
  double-run a job, but there's no reason to run more than one.
- **If the Mac mini is asleep/off**, jobs simply stay `queued` (shown with an
  amber clock in the dashboard) until the poller runs again — nothing is lost.
- **Crash safety:** if `main.py` dies without writing a terminal status, the
  poller marks the job `failed` so it doesn't wedge as `running` forever.
