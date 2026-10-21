# Dashboard city search, radius scraping, hover fix, in-app explanations

Date: 2026-07-02
Base: builds on `2026-07-01-facundo-poc-design.md` and the brief.

Five changes from user feedback: (1) search/ingest new cities from the dashboard
with adapted UX, (2)+(3) surface scrape/enrich + formula explanations in-product,
(4) fix the unreachable hover popup, (5) include florists just outside the city via
radius scraping.

## A. On-demand city ingest (item 1)

- **Route:** `POST /api/ingest` (Next.js Route Handler, Node runtime). **Auth-gated** —
  verifies the Supabase session and `isAllowed(email)` server-side; rejects everyone
  else (only allow-listed users may spend Apify/Claude credits).
- **Execution:** spawns the Python CLI with `child_process.spawn` using an **arg array
  (no shell)** — `uv run python main.py --country <c> --city <city> --radius <r>
  --limit <n>`, `cwd` = the `ingest/` dir. Reuses all ingest code; reads `ingest/.env`;
  no keys in the client bundle.
- **Streaming:** returns the CLI's stdout progress (`[1/6]…[6/6]`) as SSE via a
  `ReadableStream`. A timeout kills the process; non-zero exit streams an error event.
- **Input validation:** non-empty country/city, bounded lengths, numeric radius/limit
  within sane ranges. In-flight lock / disabled submit prevents concurrent duplicate
  ingests.
- **UX:** left "City" section gains a **"＋ Add city"** control → form (Country, City,
  radius default 10 km, limit default ~40) → **Ingest** button → live step progress →
  on success refresh the city list and select the new city.

## B. Radius scraping (item 5)

- `scrape.py`: replace the `"florist in {city}, {country}"` text query with
  `searchStringsArray: ["florist"]` + a **circular geolocation around the geocoded
  center** (center lat/lng + `radiusKm`). Confirm the exact Apify
  `customGeolocation` param against the actor's input schema at build time.
- `main.py`: add `--radius` (default 10 km); pass the geocoded center + radius to the
  scrape.
- `cities.radius_km` column added (nullable) via migration; `get_or_create_city` /
  `main.py` store it. Existing rows stay null (UI shows "—"). Enables "florists within
  N km of center" in the UI and an optional radius circle on the map.

## C. Hover popup fix (item 4)

Root cause: the popup opens on row-hover and closes on row-mouse-leave, so moving the
cursor toward it fires the close. Fix: **decouple hover from click** — hover only
*highlights* the pin (no popup race); **click** (row or pin) opens a **persistent**
popup the cursor can move into (stays until closed or another is selected). Score
breakdown continues to open on click.

## D. In-dashboard explanations (items 2 & 3)

- **"How scoring works"** info popover by the Weights heading: the formula, rationale
  (3★ baseline, `log10` review dampening, distance penalty, what each weight does), and
  a note that weights/scores are live client-side and not persisted (per item 3).
- **"How data is collected"** panel: sources (Apify/Google Maps, Nominatim),
  enrichment (rule-based → `claude-sonnet-5` fallback), edge cases (403/dead sites →
  honest null, non-deterministic Maps results, radius-based area).
- Short versions in `docs/methodology.md`.

## Route ↔ CLI contract (must align across agents)

CLI flags: `--country <str> --city <str> --limit <int> --radius <float km>`.
Route passes all four. CLI prints one progress line per step to stdout.

## Persistence (item 3 answer, unchanged)

Enrichment data is persisted and updated on re-ingest (upsert). Scoring weights and
computed scores are NOT persisted — client-side, reset to defaults on reload. Saved
weight presets are a possible future add, out of scope here.

## Build split (parallel, no file overlap)

- **backend-engineer:** `ingest/` (radius: `scrape.py`, `main.py`, `db.py`) +
  `supabase/` (schema.sql + migration for `radius_km`).
- **frontend-engineer:** all of `dashboard/` — the `/api/ingest` route, city-search
  UI + progress, hover fix, info panels, `lib/types.ts` (`radius_km`).

## Non-goals

No saved weight presets. No auth changes. No new cities auto-ingested. Keep POC-simple.
