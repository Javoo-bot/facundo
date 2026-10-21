# Jobs visualization + per-run cost (LLM + Apify), then measured optimization

Date: 2026-07-02. Adds per-run cost + timing capture to ingest jobs — both the Anthropic
(LLM) spend and the Apify (scrape) spend — surfaces it in an enriched jobs drawer and a
new `/jobs` history page, then uses that instrumentation to reduce cost and wall-clock
time with real before/after numbers.

Two cost sources, both **actual** — they differ only in how the number is obtained:
- **Apify** reports dollars directly — the actor run's `usage_total_usd` ("what you
  actually pay", per the API).
- **LLM** reports tokens, which we price exactly: `input_tokens × rate + output_tokens ×
  rate`. This is exact arithmetic, not a guess (no batch/caching discounts in play). The
  only assumption is the rate itself (published Sonnet-5 / Haiku rates, no negotiated
  discount) — a one-line footnote in the UI, not an "est." hedge.

LLM cost is tracked **per call type** (ecommerce / email / phone / owner / draft) and
**per model**, so the detail view shows exactly where the money goes — the instrument
for the model-swap experiment (workstream B). Total run cost = Apify + LLM (summed on the
client from the stored components).

Builds on `2026-07-02-background-jobs-design.md` (the `ingest_jobs` table + `JobsPanel`
drawer + `/api/jobs` route already exist). Scoring, spread, and the florist data
contract are unchanged.

## Sequencing (decided: measure first, then tune)

1. **Workstream A** — cost/timing capture (per call type + per model) + visualization.
   Ship + commit.
2. **Baseline run** — one real ingest; read the per-type cost, tokens, and duration off
   `/jobs`.
3. **Workstream B + C** — apply context trims, the model swap on the priciest call type,
   and concurrency raises, with values/targets chosen from the baseline numbers. Re-run;
   the `/jobs` page shows the before/after.

A is a complete, shippable feature on its own. B and C are a second commit whose exact
constants come from A's measurements — no guessed values baked in blind.

---

## Workstream A — cost/timing capture + visualization

### A1. Data model (`ingest_jobs` migration)

Six nullable columns, written by the CLI at job finish (so failed/partial runs still
record spend up to the failure point):

```sql
alter table ingest_jobs add column if not exists input_tokens     bigint;
alter table ingest_jobs add column if not exists output_tokens    bigint;
alter table ingest_jobs add column if not exists llm_calls        integer;
alter table ingest_jobs add column if not exists llm_cost_usd     numeric;
alter table ingest_jobs add column if not exists llm_cost_by_type jsonb;
alter table ingest_jobs add column if not exists apify_cost_usd   numeric;
alter table ingest_jobs add column if not exists florist_count    integer;
```

- `input_tokens` / `output_tokens` — summed across every real Anthropic call this run.
- `llm_calls` — count of real API calls (in-process cache hits are NOT counted).
- `llm_cost_usd` — total LLM spend, computed in Python and stored; the dashboard never
  prices, so there is no client-side pricing logic or drift. The aggregate columns above
  are kept (not just the JSONB) so the history table can query/sort without unpacking.
- `llm_cost_by_type` — the per-call-type breakdown:
  `{ "ecommerce": {calls, input_tokens, output_tokens, cost_usd, model}, "email": {…},
  "phone": {…}, "owner": {…}, "draft": {…} }`. `model` records which model served that
  type this run (so the swap experiment's before/after is self-documenting). Types that
  never ran are omitted.
- `apify_cost_usd` — the run's `usage_total_usd` (already USD; no rate math). Null if the
  actor didn't report it (see A2b).
- `florist_count` — florists processed this run; makes cost-per-florist meaningful and
  feeds the chart's x-axis labels.

Total cost is derived on the client (`llm_cost_usd + apify_cost_usd`, null-guarded) — no
stored total column to keep out of sync.

Duration is derived on the client from `started_at`/`finished_at` — no column.

Nullable + `if not exists` so the migration is safe to re-run and old rows (pre-feature)
simply render their cost cells as "—".

### A2. Ingest instrumentation — explicit `UsageTracker`

New `ingest/usage.py`:

- `PRICING` — a **per-model** dict of `{model_id: (input_per_mtok, output_per_mtok)}`,
  seeded with `claude-sonnet-5` and `claude-haiku-4-5`. Sonnet-5 uses the **intro rate**
  in effect today (**$2.00 / $10.00 per 1M**; intro runs through 2026-08-31, standard is
  $3.00 / $15.00); Haiku 4.5 is **$1.00 / $5.00**. Comments document the standard rates;
  a one-line change swaps intro→standard. A call priced against an unknown model logs a
  warning and contributes $0 rather than crashing.
- `MODEL_FOR_CALL` — a `{call_type: model_id}` mapping (`ecommerce`, `email`, `phone`,
  `owner`, `draft`), all defaulting to `claude-sonnet-5`. This is the one-line switch the
  model-swap experiment (workstream B) flips. `enrich.py` / `main.py` read the model for
  each call from here instead of a module-level `MODEL` constant.
- `@dataclass UsageTracker` — holds a per-call-type bucket
  (`calls`, `input_tokens`, `output_tokens`, `model`), plus:
  - `record(call_type, model, response)` — reads `response.usage.input_tokens` /
    `.output_tokens`, adds to that type's bucket, tags it with `model`. Tolerant of a
    missing/None `usage` (never raises).
  - `cost_for(bucket)` / `cost_usd` (grand total) — price each bucket by its own model's
    `PRICING` entry, so a run mixing Sonnet + Haiku costs out correctly.
  - `to_by_type_dict()` — the JSONB payload for `llm_cost_by_type`; aggregate
    `input_tokens` / `output_tokens` / `calls` / `llm_cost_usd` are summed from the
    buckets.

Threading (explicit, not a module global — testable, no cross-run state, counts exactly
the billed calls):

- `enrich.py::_parse(...)` gains `tracker` + `call_type` params, resolves the model via
  `MODEL_FOR_CALL[call_type]`, passes that model to the API call, and calls
  `tracker.record(call_type, model, response)`. Because `_parse` runs ONLY on a real API
  call (each helper checks `claude_cache` first and only calls `_parse` on a miss), cache
  hits correctly cost nothing. Each of the 4 extract helpers passes its own `call_type`.
- The `tracker` is threaded `main.py` → `enrich_all(florists, claude, tracker)` →
  `enrich_florist(...)` → the 4 extract helpers → `_parse`. asyncio is single-threaded,
  so `+=` after each `await` is safe (no lock needed).
- `main.py::_draft_outreach_email` uses `MODEL_FOR_CALL["draft"]`, returns
  `(text, response)`, and the draft loop records into the same tracker as `draft`.

`jobs.py::finish_job(...)` gains `usage: UsageTracker | None`, `apify_cost_usd: float |
None`, and `florist_count: int | None` params and writes the seven columns on BOTH the
success and failure paths (`llm_cost_by_type` via `to_by_type_dict()`). The write stays
best-effort (a job-tracking write failure never aborts ingest, same as today). `main.py`
passes `florist_count=len(florists)` and the Apify cost captured at the scrape step.

**Why explicit tracker over alternatives:** a return-usage-tuple-everywhere approach
churns every helper signature; a module-level global accumulator is untestable and
risks cross-run contamination. The explicit object is the cleanest of the three.

**Caching note (why prompt caching is NOT used):** Anthropic prompt caching requires a
≥1024-token cacheable prefix. All six instruction preambles are 150–370 tokens — below
the floor — so prompt caching would never activate, and the token bulk is the
per-florist HTML payload, which differs per florist and is uncacheable across them. The
in-process `claude_cache` dict (identical-call dedup within a run) is the only caching
that helps here and already exists.

### A2b. Apify cost capture

`scrape.py::scrape_florists` already holds the actor `run` object (it reads
`run.default_dataset_id`). Confirmed against apify-client 3.0.4 (`_models.py:2804`): the
run model exposes `usage_total_usd: float | None` — "Total cost in USD for this run…
what you actually pay… Requires authentication token to access." We own the run, so it's
populated.

- `scrape_florists` returns `(florists, apify_cost_usd)` — reading
  `getattr(run, "usage_total_usd", None)` (tolerant of a null/absent value → the column
  stays null, honest, never a crash).
- `main.py` captures the cost at the scrape step (step 3), holds it in a local, and
  passes it to `finish_job(...)`. Because it's captured right after the scrape, even a
  run that later fails during enrichment still records its Apify spend; a run that fails
  *during* the scrape simply has no cost to record (null).

### A3. Dashboard surfaces

**Types** (`lib/types.ts`): `IngestJob` gains `input_tokens`, `output_tokens`,
`llm_calls`, `llm_cost_usd`, `apify_cost_usd`, `florist_count` (all `number | null`) and
`llm_cost_by_type` (a `Record<string, {calls, input_tokens, output_tokens, cost_usd,
model}> | null`). A small `lib/cost.ts` helper derives `totalCost(job)` (null-guarded
sum) so the drawer and the page agree on the same total.

**API** (`app/api/jobs/route.ts`): already `select("*")`, so new columns flow through.
Add an optional `?limit=` query param (default 20 for the drawer; the page requests
more, e.g. 50). Same auth-gate + RLS-scoped read as today.

**Enriched drawer** (`JobsPanel` / `JobRow`): each row gains a compact stats line —
**duration · florist count · total cost** — with a smaller subline breaking the total
into **Apify $x · LLM $y · N calls · tokens in/out**. Running jobs render cost as
"calculating…" (not `$0.00`). Add a **"View all runs →"** link (footer of the drawer) to
`/jobs`. The header bell behavior is unchanged.

**New `/jobs` page** (`app/jobs/page.tsx` server component + a client child):
- Auth-gated the same way as the rest of the app (redirect if not signed in / not
  allow-listed); RLS-scoped read.
- **History table** — Run (city, country) · Status · Started · Duration · Florists ·
  Total cost · Apify · LLM · Tokens (in/out). Reuses the overview's table styling, status
  icons, and `tabular-nums`. Default order: most recent first.
- **Cost-over-time bar chart** — inline SVG (NO chart library: keeps the bundle
  self-contained and matches the existing inline-SVG icon convention). One **stacked**
  bar per run (recent N): an Apify segment + an LLM segment, total height ∝ total cost,
  labeled with city + total; failed/all-null runs render a muted zero-height tick. A
  legend distinguishes the two segments; a caption notes the rate basis + Apify-actual.
- **Per-run detail** — clicking a row opens a panel (reuse the city page's non-modal
  drawer pattern) showing the full `log` plus the cost breakdown: Apify, total,
  total-cost-per-florist, and an **LLM per-call-type table** from `llm_cost_by_type`
  (type · model · calls · tokens · cost, one row per type) — this is where the
  model-swap experiment's before/after is read.
- Empty state (no runs yet) and a "← Overview" back link.

**Header link:** the bell in `JobsPanel` keeps opening the live drawer; the drawer's
"View all runs →" is the path to the page (bell stays a quick live peek, page is the
history/analysis surface).

### A4. Edge cases

- Running job → cost/token columns null → "calculating…", not `$0.00`.
- Every Anthropic call fails → `llm_calls=0`, `llm_cost_usd=0`, `llm_cost_by_type={}`
  (honest zero, not null).
- Apify didn't report `usage_total_usd` (null/absent) → `apify_cost_usd` null → Apify
  cell shows "—" while the LLM component and total (LLM-only) still render.
- Both components null (e.g. old pre-feature rows) → total shows "—".
- `response.usage` missing/None → `record` no-ops for that call (never crashes ingest).
- A call priced against a model not in `PRICING` → logged warning, $0 contribution (the
  tokens still count); prevents a mid-experiment typo in `MODEL_FOR_CALL` from crashing.

### A5. Tests

- `usage.py`: `UsageTracker.record` buckets by call type; `cost_usd` matches a
  hand-computed figure for a **mixed-model** run (a Sonnet call + a Haiku call priced by
  their respective rates); `to_by_type_dict()` shape is correct; a None-usage response
  and an unknown-model call both no-op safely. (A handful of asserts, POC-scale.)
- `lib/cost.ts`: `totalCost` sums both components and null-guards (null+num = num,
  null+null = null). One or two asserts.
- `_append_bounded_log` / existing job tests unaffected.

---

## Workstream B — cost reduction (values from the baseline run)

Applied after A's baseline shows where tokens actually go. Levers, in expected-impact
order:

1. **Trim context sent to Claude.** email/phone extraction currently ships
   `combined_html[:4000]` as raw context, but candidates are already regex-extracted —
   Claude only needs the candidate list + a small text window around each candidate.
   Cut to a targeted excerpt (target ~60–70% fewer context tokens on those two calls).
   Reduce ecommerce (`[:6000]`) and owner (`[:8000]`) excerpts similarly if the baseline
   shows headroom. Every char limit becomes a named constant.
2. **Model swap on the priciest call type (decided: measure-first).** The baseline's
   `llm_cost_by_type` shows which type costs the most. Flip that type's entry in
   `MODEL_FOR_CALL` to `claude-haiku-4-5` (~half the per-token cost), re-run the same
   city, and compare: `llm_cost_by_type` gives the exact saving, and a spot-check of that
   type's outputs on the baseline florists (did emails/phones/owners/ecommerce flags stay
   correct?) guards quality. If adopted, update `CLAUDE.md` (which currently pins
   `claude-sonnet-5`) and note the per-type model in the design record; if quality drops,
   revert the one line. The per-type/per-model tracking (A2) makes this a measured
   decision, not a guess.
3. **Skip the LLM on unambiguous single candidates.** Exactly one email candidate from a
   `mailto:` on a contact page, or one `tel:` phone → take it directly, skip the call.
   Eliminated calls beat cheaper calls. Guarded so it never lowers result quality
   (only fires when there is a single, high-provenance candidate).
4. **In-process cache** — already dedupes identical calls within a run; kept as-is.

Not used: Anthropic prompt caching (preambles below the 1024-token floor — see A2) and
the Batch API (its async/up-to-24h model breaks the watch-it-run-live UX).

## Workstream C — speed (values from the baseline run)

1. **Raise concurrency caps** — `MAX_CONCURRENT_ENRICHMENTS` 5→10,
   `MAX_CONCURRENT_RENDERS` 3→4 (both already named constants). Work is I/O-bound, so
   more concurrency shortens wall-clock — up to the real ceiling.
2. **Optional: `AsyncAnthropic`** — replace the sync `Anthropic` client dispatched via
   `asyncio.to_thread` with the native async client (`await client.messages.parse/…`),
   removing the thread-pool hop. Clean win; slightly larger refactor of the 5 call
   sites.
3. **Ceiling to respect** — Anthropic rate limits + website politeness. Past a point the
   SDK's auto-retry backoff *slows* the run; the baseline + a tuning run tell us where
   that point is. Nominatim politeness (≤1 req/s) is untouched — it's a separate,
   already-throttled path.

Every knob is a named constant so tuning is a one-line change, and `/jobs` shows cost +
duration per run so each adjustment's effect is visible.

## Non-goals

No websockets/Realtime (the drawer keeps polling). No cost budgets/alerts. Cost covers
Apify + LLM only — Nominatim geocoding is free and not tracked. LLM cost is broken down
per call type but not per individual call (hundreds of calls/run — the 5 type buckets are
the useful grain). No historical charts beyond recent-N stacked cost bars. The model swap
is a measured single-type experiment (workstream B), not a general per-call routing
engine. Apify cost is not itself an optimization target (workstream B/C tune LLM cost +
wall-clock); we surface it so the total is honest.

## Build split

- **backend-engineer** → `ingest/` + `supabase/`: A1 migration (7 columns incl.
  `llm_cost_by_type` JSONB), A2 `usage.py` (per-model `PRICING`, `MODEL_FOR_CALL`,
  per-type `UsageTracker`) + threading + `jobs.py`/`main.py` wiring, A2b Apify-cost
  capture in `scrape.py`, A5 tests. Later: B (context trims + measured model swap) + C
  with baseline-derived constants.
- **frontend-engineer** → `dashboard/`: A3 types + `lib/cost.ts`, `/api/jobs` `?limit=`,
  enriched drawer, new `/jobs` page (table + stacked SVG chart + per-run detail with the
  per-call-type cost table).
