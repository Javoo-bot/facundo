# Localized search, re-run, draft-email UI, enrichment overhaul

Date: 2026-07-02
Builds on the prior specs and the brief. Five changes, most sharing new enrichment
plumbing (headless render + bounded internal-link crawl + multilingual extractors).

## A. Localized keywords + cache

Problem: searching the English "florist" under-collects in non-English destinations
("florista"/"floristería"/"floristeria" return different Google Maps results).

- **`country_keywords` table** — `country text primary key`, `keywords jsonb not null`,
  `language text`, `updated_at timestamptz default now()`. RLS enabled, **no policies**
  (service-role managed only, like `allowed_emails`). Migration + `schema.sql`.
- **`ingest/keywords.py`** — `get_keywords_for_country(client, country) -> (keywords,
  language)`: read cache; on miss call Claude (`claude-sonnet-5`, structured output
  `{keywords: [...], language: "<maps lang code>"}`) for common local-language florist
  terms (incl. multilingual regions), write cache, return. Also an upsert helper for a
  user-confirmed set.
- **`ingest/derive_keywords.py`** (small CLI) — `python derive_keywords.py --country X`
  prints `{"keywords": [...], "language": "es"}` (cache-first). The dashboard's
  `/api/keywords` route spawns this.
- **`prompts.py`** — `KeywordSuggestion` pydantic model + prompt.
- **`scrape.py`** — `scrape_florists(center_lat, center_lng, radius_km, limit,
  keywords: list[str], language: str)`: `searchStringsArray = keywords`,
  `language = <local>` (replaces hard-coded `["florist"]`/`"en"`), same radius
  geolocation. Dedup by `place_id` (already). Note: `maxCrawledPlacesPerSearch` is
  **per keyword** — total raw ≈ keywords × limit before dedup (intended "maximize").
- **`main.py`** — add `--keywords` (comma-separated, optional) + `--language`
  (optional). Given `--keywords`, use them AND upsert to `country_keywords`; omitted,
  derive via `keywords.py`. `--country --city --radius --limit` unchanged.

## B. Re-run an existing city

Dashboard "↻ Re-run" control by the city selector for the currently-selected
(already-ingested) city. Reuses that city's stored `country`, `radius_km`, and cached
keywords; runs the same streaming `/api/ingest`. Idempotent upsert refreshes the data.
Same live-progress UI as Add-city.

## C. Draft email in the UI

`florists.drafted_email` is stored but never surfaced. Add an **"Outreach draft"**
section to the score-breakdown side panel (monospace block + copy button) and a small
✉ indicator in the table for florists that have one. Display-only — already fetched via
`select("*")`.

## D. Enrichment overhaul (items 4 + 5 share this)

Rebuild the per-florist enrichment around discovery + rendering + multilingual
extraction.

- **Headless rendering (Playwright)** — add `playwright` dep; one-time
  `playwright install chromium` (documented in README; run during verification).
  Static `httpx` fetch first (fast); when a page is thin/JS-shell or yields no signals,
  render it headlessly to get the real DOM. Separate low concurrency (~2–3) from the
  httpx semaphore.
- **Bounded internal-link crawl** — from the (rendered) homepage, collect internal
  links, prioritize contact/shop/location/about-like URLs
  (`contact`/`contacto`/`contacte`/`kontakt`, `tienda`/`botiga`/`shop`/`store`/`comprar`,
  location pages, `about`/`sobre`), and fetch/render a **capped set** (≤ ~8 pages total,
  5s each). Replaces the fixed guessed-path list. This is what fixes Floristería Ejemplo
  (homepage is a 1.5 KB JS shell; the email + shop live on `/barcelona/`).
- **Email extraction** — over all collected/rendered content: plain-text regex
  (already), **`mailto:` hrefs**, **JSON-LD/structured-data**, **de-obfuscation**
  (`(at)`/`[at]`/` at `, ` dot `). Claude selects the primary business email from the
  richer candidate set (skip noreply/CDN/wixsite).
- **Ecommerce detection** — combine: **Google Maps online-ordering signal** from the
  Apify item (`orderBy` / service-options / order links — verify the exact field at
  build time against the actor schema, like the radius param) as a strong positive;
  **broadened static rules** — localized cart/shop terms (`carrito`, `cesta`, `comprar`,
  `tienda`, `botiga`, "add to basket", "finalizar compra"), more platforms
  (squarespace/wix stores, ecwid, …), florist-network markers (Interflora
  `#LivingWithFlowersEveryday`, Teleflora); over the rendered DOM. Claude fallback on
  the best-available content when rules find nothing.
- Phone + owner extraction benefit from the richer content; logic otherwise unchanged.
- Everything recorded in `enrichment_notes`. Honest nulls preserved.

## Contracts (align across agents)

- **CLI:** `main.py --country <str> --city <str> --radius <float> --limit <int>
  [--keywords "a,b,c"] [--language <code>]`.
- **`derive_keywords.py`:** `--country <str>` → stdout JSON `{keywords, language}`.
- **`POST /api/keywords`** (auth-gated): body `{country}` → `{keywords, language}`
  (spawns `derive_keywords.py`, cache-first).
- **`POST /api/ingest`** (auth-gated): body `{country, city, radius, limit, keywords[],
  language}` → spawns `main.py` with those. Re-run sends the existing city's values.
  Validate keywords (array of short strings, ≤ ~10).

## Migrations

`supabase/migrations/2026-07-02-country-keywords.sql` — create `country_keywords` +
enable RLS (no policies). User runs it in the SQL editor.

## Setup

README: `cd ingest && uv sync && uv run playwright install chromium` (one-time browser
download). The machine running the dashboard/ingest needs chromium installed.

## Build split (parallel, non-overlapping dirs)

- **backend-engineer:** `ingest/` (`keywords.py`, `derive_keywords.py`, `prompts.py`,
  `scrape.py`, `main.py`, `enrich.py` overhaul + Playwright, `db.py` incl. `radius_km`
  reuse, `pyproject.toml`) + `supabase/` (table + migration) + README setup note.
- **frontend-engineer:** `dashboard/` — `/api/keywords`, `/api/ingest` (keywords +
  re-run passthrough), `AddCityForm` (editable keyword chips + fetch on country),
  re-run button, draft-email display (side panel + table ✉).

## Non-goals

No auth changes. No saved weight presets. Keep POC-simple; the link crawl stays bounded
(≤ ~8 pages) and headless concurrency low.
