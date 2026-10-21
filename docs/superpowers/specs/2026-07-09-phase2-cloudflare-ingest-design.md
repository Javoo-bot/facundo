# Phase 2 — TS-on-Cloudflare ingest rewrite

**Date:** 2026-07-09
**Parent roadmap:** `2026-07-09-productionization-roadmap-design.md`
**Status:** Approved direction (roadmap); this is the detailed design.

Rewrite the Python ingest pipeline (`ingest/`, ~1,400 lines of logic) as a
Cloudflare-native TypeScript system so it runs on Workers instead of the
Mac-mini poller. **Phase 1 (render-rate measurement) was skipped by request** —
so Browser Rendering ships behind a flag, off by default, and the pipeline is
correct and useful without it (see §Browser Rendering).

## Cutover strategy (zero dashboard change)

The dashboard's `POST /api/ingest` already inserts `queued` `ingest_jobs` rows
and the jobs panel reads that table. We **keep that contract untouched** and
replace only the *claimer*: the Mac-mini poller (`ingest/poll_jobs.py`) is
superseded by a Cloudflare Worker that claims the same `queued` rows.

```
dashboard POST /api/ingest  (UNCHANGED)
      │  inserts ingest_jobs row {status:"queued"}
      ▼
┌─────────────────────────── ingest-worker (new CF Worker) ───────────────────────────┐
│ Cron trigger (every 1 min): claim queued rows                                        │
│   UPDATE ingest_jobs SET status='running' WHERE id=? AND status='queued'  (atomic)   │
│   → for each claimed row: env.INGEST_QUEUE.send({jobId, country, city, ...})          │
│                                                                                       │
│ Queue consumer (ingest-city-queue): for each message                                 │
│   → env.CITY_WORKFLOW.create({ id: jobId, params })   (one Workflow instance/city)   │
│                                                                                       │
│ CityIngestWorkflow (WorkflowEntrypoint) — durable, per-city, step-checkpointed:      │
│   step 1  geocode + get/create city (Nominatim)                                      │
│   step 2  resolve keywords (Supabase cache → Claude)                                 │
│   step 3  Apify run: start → poll → fetch dataset items  (start/poll are own steps)  │
│   step 4  distance-from-center + exclude-list filter                                 │
│   step 5  persist bare rows (city queryable early)                                   │
│   step 6  enrich florists — bounded-concurrency Promise.all over per-florist          │
│           step.do(`enrich:${placeId}`) ; each upserts its own full row               │
│   step 7  finish job (status, tokens, cost, florist_count)                           │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Why Cron-claim → Queue → Workflow (not dashboard→Queue directly):** it needs
no change to the dashboard Worker (no cross-worker binding, no redeploy), reuses
the entire `ingest_jobs` + jobs-panel plumbing, and the atomic `queued→running`
claim prevents double-processing across Cron ticks. The Queue adds
backpressure/retry/DLQ for high volume; the Workflow adds durable per-city
execution with step-level retries and isolation — a city that fails on Apify
retries its step and never touches another city. (Latency note: Cron min
interval is 60s, vs. the poller's ~seconds. Acceptable for Phase 2; a future
dashboard→Queue nudge can cut it.)

## New package: `ingest-worker/`

A standalone Wrangler TypeScript Worker, sibling to `dashboard/` and `ingest/`.
`ingest/` stays in the repo (manual runs, reference) until §Decommission.

```
ingest-worker/
  wrangler.jsonc         # bindings: Queue (producer+consumer), Workflow, Browser,
                         #   DO (BROWSER_POOL), Cron; nodejs_compat; secrets
  package.json           # deps below; scripts: dev, deploy, test, typecheck
  vitest.config.ts       # @cloudflare/vitest-pool-workers for unit tests
  src/
    index.ts             # Worker entry: scheduled() Cron-claim, queue() consumer,
                         #   fetch() dev-only manual trigger + health
    workflow.ts          # CityIngestWorkflow (WorkflowEntrypoint), steps 1-7
    geocode.ts           # Nominatim fetch + haversine distance (port geocode.py)
    keywords.ts          # country_keywords cache + Claude KeywordSuggestion
    apify.ts             # Apify REST (start/poll/items) + normalize + dedup
    phones.ts            # libphonenumber-js normalize + country→ISO2 region
    enrich.ts            # the enrichment core (port enrich.py) — see §Enrichment
    extractors.ts        # pure HTML extractors (emails/phones/JSON-LD/links/ecommerce)
    llm.ts               # Anthropic structured-output helper (tool-forcing)
    db.ts                # @supabase/supabase-js service client + upsert helpers
    usage.ts             # UsageTracker port (per-call-type cost)
    jobs.ts              # ingest_jobs create/progress/finish (port)
    browserPool.ts       # Durable Object warm pool for Browser Rendering (flag-gated)
    types.ts             # shared types (Florist row, EnrichmentResult, job message)
    config.ts            # all constants (limits, timeouts, pricing, model routing)
  test/                  # unit tests mirroring src/
```

**Dependencies:** `@supabase/supabase-js`, `@anthropic-ai/sdk`, `cheerio`
(BeautifulSoup→cheerio), `libphonenumber-js` (phonenumbers→), `i18n-iso-countries`
(pycountry→ name/code→ISO2), `@cloudflare/workers-types`, `wrangler`, `vitest`,
`@cloudflare/vitest-pool-workers`, `@cloudflare/puppeteer` (Browser Rendering).

## Module ports (faithful to the Python)

- **geocode.ts** — `geocodeCityCenter(country, city) → {lat, lng, region}` via
  `GET https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=<city>,<country>`
  with header `User-Agent: facundo-poc-ingest/0.1 (contact: staff@fc.example.com)`
  and a ≤1 req/sec throttle (module-level timestamp, `step.sleep` if needed).
  Region = first present of `state|province|region|state_district` in
  `address`. `haversineKm(a, b)` replaces geopy `geodesic` for distance.
- **keywords.ts** — `getKeywordsForCountry(supabase, country) → {keywords, language}`,
  cache-first on `country_keywords`; miss → `llm.structured(KeywordSuggestion, prompt)`
  on `claude-sonnet-5`, then upsert. `normalizeCountry` (≤3 chars → upper, else
  title-case). `upsertKeywordsForCountry`. Prompts verbatim from `prompts.py`.
- **apify.ts** — `scrapeFlorists(center, radiusKm, limit, keywords, language) →
  {florists, apifyCostUsd}`. Uses the Apify REST API (not the Node client):
  `POST /v2/acts/compass~crawler-google-places/runs?token=…` with the exact
  `run_input` from `scrape.py` (`searchStringsArray`, `customGeolocation`
  Point+`radiusKm` with `[lng,lat]`, `maxCrawledPlacesPerSearch`, `language`),
  then **poll the run** (`GET /v2/actor-runs/{id}`) until `SUCCEEDED`/`FAILED`
  (this polling is a Workflow step so it survives long runs), then
  `GET /v2/datasets/{defaultDatasetId}/items`. `usageTotalUsd` → apifyCostUsd.
  Normalize + dedup-by-`placeId` + `_extractMapsOnlineOrder` (label keywords
  verbatim). Drop rows with no `placeId`.
- **phones.ts** — `countryToRegion(country) → ISO2|null` (alpha-2/alpha-3 exact,
  else `i18n-iso-countries` name lookup); `normalizePhone(raw, region) → string`
  via `libphonenumber-js` `parsePhoneNumberFromString`, formatted
  `.formatInternational()`; returns `raw` unchanged if falsy/unparseable/invalid
  (honest, no data loss).
- **db.ts** — service-role `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`;
  ports `getOrCreateCity` (cache-first + region backfill + radius update),
  `getCityCenter`, `softDeleteCityFlorists`, `getExcludedPlaceIds`,
  `upsertFlorists` (on_conflict `city_id,place_id`), `buildBareRow`, `buildRow`.
  **`buildRow` omits `drafted_email`** (Phase 0 invariant — never null a draft).
- **usage.ts / jobs.ts** — direct ports. `MODEL_FOR_CALL` unchanged
  (ecommerce/owner on Sonnet-5; email/phone on Haiku-4.5). `_appendBoundedLog`
  (last 50 lines). Cost + tokens + `llm_cost_by_type` written on finish.
- **llm.ts** — `structured<T>(schema, model, prompt, maxTokens) → {parsed, usage}`
  using `messages.create` with a single forced tool whose `input_schema` is the
  JSON schema for the model (Anthropic TS has no pydantic `.parse()`); read the
  `tool_use` block's `input`. `text(model, prompt, maxTokens)` for free-form.
  No temperature/prefills. This is the CLAUDE.md "structured outputs" convention
  in TS.

## Enrichment (`enrich.ts` + `extractors.ts`)

Ported from `enrich.py` per the code-explorer manifest (authoritative for every
constant, threshold, and extractor). Key faithful behaviors:

- **Discovery order per florist:** static fetch → thin/JS-shell check → render
  fallback (if enabled) → bounded internal-link crawl (ranked) → social fallback
  → run extractors over collected pages → up to 3 Claude calls.
- **Constants** (`config.ts`, verbatim): `MAX_PAGES_PER_FLORIST=8`,
  `MAX_CONCURRENT_ENRICHMENTS`, `MAX_CONCURRENT_RENDERS=4`, fetch/render timeouts,
  thin-page threshold, `SKIP_LINK_SCHEMES`/`EXTENSIONS`, social host list, link
  score weights.
- **Extractors (pure, unit-tested):** `extractCandidateEmails` (+ deobfuscation),
  `extractCandidatePhones`, JSON-LD email/phone (`_findEmailsInJson`/`Phones`),
  `detectEcommerceSignals` (rule-based platform/cart/schema), `collectInternalLinks`,
  `rankLinks`/`scoreLink`, `isThinPage`, `isSocialUrl`, `extractSocialLinks`,
  `unwrapRedirectLink`, `buildFocusedContext`, `extractTextForOwner`.
- **Claude calls:** `classifyEcommerce` (Sonnet-5, only when rules inconclusive),
  `extractEmail` (Haiku-4.5, selection from candidates), `extractPhone` (Haiku-4.5),
  `extractOwnerInfo` (Sonnet-5). Each records usage on the tracker.
- **Returned `EnrichmentResult`** — every key the Python enrichment dict sets:
  `has_website, is_ecommerce, ecommerce_signals, email, phone_web, owner_name,
  shop_highlight, enrichment_notes` (+ transient `content_language`, **not
  persisted**, matching Phase 0).
- **Concurrency in the Workflow:** enrich florists via `Promise.all` over a
  bounded pool (cap `MAX_CONCURRENT_ENRICHMENTS`) of `step.do(\`enrich:\${placeId}\`,
  …)` — each florist is a durable, retryable step that upserts its own full row
  on completion (mirrors the Python per-florist `finalize`). Render calls share a
  global concurrency cap via the DO pool.

## Browser Rendering (flag-gated, off by default)

The Python already treats "no browser" as a valid degraded mode (`render_page`
returns `None` when `browser is None`, and downstream code records honest
"rendered but blocked"/thin nulls). The port preserves this exactly:

- `config.ts` `ENABLE_BROWSER_RENDER` (from env, default `false`). When off,
  `renderPage()` returns `null` and the static-first pipeline runs unchanged —
  thin/JS-shell pages simply yield whatever static gave (honest nulls). **The
  pipeline is correct and useful with render off.**
- When on: `renderPage(url)` acquires a session from `BROWSER_POOL` (Durable
  Object warm pool over the `BROWSER` binding via `@cloudflare/puppeteer`),
  bounded to `MAX_CONCURRENT_RENDERS`, with a per-run render budget; best-effort
  (any failure → `null`). The DO reuses sessions to amortize the 1-launch/sec
  limit (see roadmap §Browser Rendering).
- **Phase 1 debt:** because render-rate wasn't measured first, we ship render
  OFF, deploy + measure the *actual* render demand from production `enrichment_notes`
  (how many pages came back thin), then enable + size the pool. Turning it on is a
  secret/flag flip + provisioning, not a code change.

## Verification

- **Unit tests** (vitest, Workers pool) for every pure module: phones, geocode
  distance, all extractors (emails+deobfuscation, phones, JSON-LD, ecommerce
  rules, link ranking, thin-page, social), apify normalize/dedup, usage cost,
  jobs bounded-log, keyword normalize. These are the correctness backbone.
- **Local integration** via `wrangler dev` (miniflare emulates Queue/Workflow/DO/
  Cron; external HTTP works): trigger `POST /__run {country,city,radius,limit}`
  (dev-only) and run a **real small city** (2-3 keywords, limit ~10) against real
  Apify/Nominatim/Anthropic/Supabase using secrets from `.dev.vars` (copied from
  `ingest/.env`). Confirm rows land in Supabase with enrichment populated
  (nullable where unknown), re-run is stable (idempotent upsert), and any
  existing `drafted_email` survives. Render OFF for this run.
- **Not verifiable without the user's Cloudflare account** (flag honestly):
  production deploy (`wrangler login` + provisioning Queue/Workflow/Browser
  Rendering, which needs a paid plan), the Cron-claim path against the real
  `ingest_jobs` queue end-to-end, and the Browser Rendering fallback (remote-only).

## Decommission (final, needs user go-ahead)

Once deployed and a real city is confirmed ingesting on CF: stop the Mac-mini
launchd poller, and update `dashboard/DEPLOY.md` + `ingest/POLLER.md` to point at
the Worker. `ingest/` (the Python CLI) stays for manual/reference use. This step
is gated on the user (it's the actual production cutover).

## Non-goals

- No change to the `ingest_jobs`/`cities`/`florists`/`country_keywords` schemas.
- No change to the dashboard (it already enqueues; the jobs panel already reads).
- No scheduled *re-enrich* cron logic yet beyond the claim-sweep (the roadmap's
  "scheduled refresh" is a later, separate cron using the same Workflow).
