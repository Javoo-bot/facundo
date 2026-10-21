# Ingest pipeline

Python 3.11+ CLI that scrapes florists for one city (Apify), enriches them
(website, ecommerce, email, phone, distance, owner) with `httpx` +
`beautifulsoup4` + Claude, and upserts them into Supabase. Managed with
[`uv`](https://docs.astral.sh/uv/).

Two ways it runs:

- **Manually** — `uv run python main.py …` on your machine.
- **From the deployed dashboard** — the Cloudflare Worker can't run Python, so
  "Re-run" / "Add city" enqueue a row in `ingest_jobs`, and a long-running
  **poller** (`poll_jobs.py`) on a Mac claims each job and runs `main.py`. See
  [Run the poller as an always-on daemon](#run-the-poller-as-an-always-on-daemon)
  and [`POLLER.md`](./POLLER.md) for the full design.

## Setup

```bash
cd ingest
uv sync                 # create .venv and install deps
cp .env.example .env    # then fill in the four values below
```

`.env` must contain all four (the pipeline reads them via `load_dotenv()`; the
poller checks them before each run):

```
APIFY_TOKEN=apify_api_...          # Apify API token — MUST start with apify_api_
OPENROUTER_API_KEY=sk-ant-...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...      # service role — ingest writes bypass RLS
```

Where to get the Apify token: **Apify Console → Settings → Integrations → API
tokens**. It always starts with `apify_api_`. Do not paste a Resend (`re_…`),
Anthropic (`sk-ant-…`), or Supabase key here — a mismatched key fails with
`UnauthorizedError: User was not found or authentication token is not valid`
(see [Troubleshooting](#troubleshooting)).

## Run the ingest manually

```bash
cd ingest
uv run python main.py --country US --city Boston
```

Flags:

| Flag | Default | Purpose |
|------|---------|---------|
| `--country` | *(required)* | Country name, e.g. `"US"` |
| `--city` | *(required)* | City name, e.g. `"Boston"` |
| `--limit` | `100` | Max florists to scrape from Apify (per keyword) |
| `--radius` | `10.0` | Search radius in km around the geocoded city center |
| `--keywords` | *(derived)* | Comma-separated localized keywords, e.g. `"florist,floristeria"`. If given, used as-is **and** cached into `country_keywords` (needs `--language`). If omitted, derived or read from cache. |
| `--language` | — | Google Maps language code (e.g. `es`). Required with `--keywords`. |
| `--job-id` | — | UUID from the dashboard to track progress in `ingest_jobs`. Omit for local runs. |
| `--reset-existing` | off | Soft-delete the city's existing florists before scraping (they resurrect if they reappear). |

Ingest is **idempotent** — it upserts on `(city_id, place_id)`, so re-running the
same city updates rather than duplicates. Verify a run landed 50–150 rows in
Supabase with enrichment populated (nullable where genuinely unknown), then
re-run and confirm the count is stable.

## Run the poller as an always-on daemon

On the Mac that should service dashboard-triggered jobs, install `poll_jobs.py`
as a **launchd LaunchAgent** — it starts at login and restarts on crash.

### Install

```bash
cd ingest

# 1. Fill the template's three placeholders and write the agent:
UV_PATH="$(which uv)"
INGEST_DIR="$(pwd)"
AGENT_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin"
sed -e "s|{{UV_PATH}}|$UV_PATH|g" \
    -e "s|{{INGEST_DIR}}|$INGEST_DIR|g" \
    -e "s|{{PATH}}|$AGENT_PATH|g" \
    com.facundo.ingest-poller.plist.example \
    > ~/Library/LaunchAgents/com.facundo.ingest-poller.plist

# 2. Validate it:
plutil -lint ~/Library/LaunchAgents/com.facundo.ingest-poller.plist

# 3. Load + start it (modern syntax — NOT the deprecated load/unload):
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.facundo.ingest-poller.plist
launchctl enable    gui/$(id -u)/com.facundo.ingest-poller
launchctl kickstart gui/$(id -u)/com.facundo.ingest-poller
```

> Use `bootstrap` / `bootout` / `kickstart`, **not** the old
> `launchctl load` / `unload`. On modern macOS the deprecated commands fail with
> a useless `Input/output error` (5).

### Verify it's running

```bash
# launchd state (look for state = running, a pid, RunAtLoad + KeepAlive):
launchctl print gui/$(id -u)/com.facundo.ingest-poller | \
  grep -Ei 'state =|pid =|last exit|keepalive'

# the process itself:
pgrep -fl poll_jobs.py

# healthy startup log looks like:
#   [poller] watching ingest_jobs for queued runs (every 4.0s)…
tail -f /tmp/facundo-ingest-poller.out.log /tmp/facundo-ingest-poller.err.log
```

### Manage it

```bash
# restart (after editing .env or pulling new code):
launchctl kickstart -k gui/$(id -u)/com.facundo.ingest-poller

# stop / uninstall:
launchctl bootout gui/$(id -u)/com.facundo.ingest-poller
rm ~/Library/LaunchAgents/com.facundo.ingest-poller.plist
```

`main.py` re-reads `.env` on **every** run, so after editing a key you don't
strictly need to restart — the new value takes effect on the next queued job.
Restart only to be certain, or after changing the poller loop itself.

### Truly always-on

A LaunchAgent only runs while the user is **logged in**, and it won't process
jobs while the Mac is **asleep**. For an unattended box (e.g. a Mac mini):

- enable **auto-login** (System Settings → Users & Groups), and
- prevent sleep: `sudo pmset -a sleep 0 disablesleep 1` (or System Settings →
  Energy → "Prevent automatic sleeping").

If the Mac is asleep/off, jobs simply stay `queued` (amber clock in the
dashboard) until the poller runs again — nothing is lost.

### Run the poller in the foreground (to test)

```bash
cd ingest
uv run python poll_jobs.py
# override the 4s poll interval:
POLLER_INTERVAL_S=10 uv run python poll_jobs.py
```

## Troubleshooting

**`UnauthorizedError: User was not found or authentication token is not valid`**
(raised from `scrape.py` during the Apify step) — the `APIFY_TOKEN` in `.env` is
wrong. Almost always it's the *wrong key entirely*: a valid Apify token starts
with `apify_api_`. If yours starts with `re_` (Resend), `sk-ant-` (Anthropic),
or is a Supabase key, that's the bug. Check the prefix without printing the whole
secret:

```bash
cd ingest
sed -n 's/^APIFY_TOKEN=\(..........\).*/prefix: \1/p' .env   # want: apify_api_
```

Fix `.env`, then either wait for the next queued job or restart the poller
(`launchctl kickstart -k gui/$(id -u)/com.facundo.ingest-poller`). A job that
already failed stays failed — re-trigger it from the dashboard.

**`Missing required environment variables: …`** — one of the four `.env` keys is
absent or empty. The poller prints this and exits before running `main.py`.

**Poller not picking up jobs** — confirm it's actually running
(`pgrep -fl poll_jobs.py`), the Mac is awake and logged in, and the deployment is
in queue mode (`INGEST_MODE=queue`). Only **one** poller should run at a time;
the claim is optimistic so a second can't double-run a job, but there's no reason
to run more than one.

**Poller crash-loops immediately** — check `/tmp/facundo-ingest-poller.err.log`.
Usual causes: `.venv` not synced (`uv sync`), a bad `.env` value, or a wrong
`{{UV_PATH}}`/`{{PATH}}` in the plist so `uv` isn't found.
