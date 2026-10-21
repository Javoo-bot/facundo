# Phase 0 — On-demand drafting + multi-city input

**Date:** 2026-07-09
**Parent roadmap:** `2026-07-09-productionization-roadmap-design.md`
**Status:** Approved design; ready for implementation plan.

Two independent features shipped together because both are quick wins on the
*current* stack (dashboard on Cloudflare, Python ingest on the Mac-mini poller)
and both are forward-compatible with the Phase 2 rewrite. Nothing here is thrown
away at cutover.

---

## Feature A — On-demand email drafting

### Goal

Stop drafting outreach emails inside the batch ingest pipeline. Draft **only when
a signed-in user asks**, per-florist or for a selected set. Cheaper/faster ingest
runs; drafts are generated against the freshest florist data at the moment of the
request.

### Current behavior (to remove)

`ingest/main.py::finalize` drafts an email for every florist that has an email
(`_draft_outreach_email` → Claude `claude-sonnet-5`, `max_tokens=1024`), stores it
in `florists.drafted_email` as `"Subject: <line>\n\n<body>"`, and records `draft`
cost on the job. `_build_row` (main.py:356) writes `drafted_email` on every
upsert.

### Changes

**1. Remove drafting from the pipeline (`ingest/`):**
- Delete the draft call in `finalize` (main.py ~210–215) and the `drafted`
  counter/echo (main.py ~222–225). Remove the now-unused `EMAIL_DRAFT_PROMPT`
  import and `_draft_outreach_email`/`resolve_target_language` *usage* in the
  pipeline (keep the functions only if reused elsewhere; otherwise delete).
- **Critical:** stop the pipeline writing `drafted_email` at all. Remove the
  `"drafted_email": florist.get("drafted_email")` key from `_build_row`
  (main.py:356) so **re-ingesting a city never wipes an on-demand draft.** Upsert
  must leave the existing `drafted_email` value untouched.
- Drop `draft` from the pipeline's `MODEL_FOR_CALL` usage path (the constant can
  stay; it's reused by the new route via the TS port).

**2. New TS drafting module (`dashboard/lib/draftEmail.ts`):**
- Port `EMAIL_DRAFT_PROMPT` (from `ingest/prompts.py`), the greeting/opening
  instruction builder, and `resolve_target_language` to TypeScript.
- `buildDraftPrompt(florist, city, regionLanguage)` mirrors
  `_draft_outreach_email` exactly, including all branches (owner_name present/
  absent; shop_highlight vs rating+review_count vs generic opening).
- **Output contract:** the model must return `"Subject: <line>\n\n<body>"` — the
  existing `lib/outreach.ts::parseDraft` regex depends on the literal `Subject:`
  label. Preserve it. (See the parseDraft contract note referenced in the git
  history.)

**3. Anthropic client:**
- Add `@anthropic-ai/sdk` to `dashboard/package.json` (Workers-compatible; also
  the foundation for Phase 2's TS LLM calls). Model `claude-sonnet-5`,
  `max_tokens: 1024`, plain text completion (no structured output — drafting is
  free-text). No `temperature`/prefills (current models reject them).
- Read `ANTHROPIC_API_KEY` from `process.env` (add to Worker secrets via
  `wrangler secret put` + local `.env.local`/`.dev.vars`).

**4. Region language source:** on-demand we lack the ingest-time `--language`.
Resolve `regionLanguage` from `country_keywords.language` for the florist's
country (that table already stores the per-country Maps language). Fallback chain
stays `content_language → regionLanguage → "en"` (matches `resolve_target_language`).

**5. Route — one route handles single and bulk:**
`POST /api/florists/draft-email` (nodejs runtime, `force-dynamic`).
- **Auth gate first:** `createServerClient().auth.getUser()` + `isAllowed(email)`
  (same pattern as `exclude`/`note`/`outreach/send`). 401/403 on failure.
- Body: `{ floristIds: string[] }`, length `1..25` (bounds cost + Worker CPU/time;
  the per-florist button sends a single-element array).
- After the gate, use `createServiceClient()` for reads+writes (florists writes
  bypass RLS, as with `exclude`). Fetch the florist rows + each florist's
  `country_keywords.language`.
- Draft each florist with bounded concurrency (≤5 in flight). Overwrite
  `drafted_email` (regenerate = overwrite). Drafting is allowed even if the
  florist has **no** email — it's an explicit request; sending remains separately
  gated on a recipient address.
- Response: `{ results: [{ floristId, ok, draft?, error? }] }` — partial success
  allowed. Per-florist Anthropic failure yields `ok:false` for that id only,
  never a partial/blank write.

**6. UI:**
- **Per-florist:** in the outreach surface (`OutreachSendPanel` / `FloristTable`
  row where the "draft ready" indicator lives), when `drafted_email` is empty show
  a **"Draft email"** button; when present show **"Regenerate."** Click → POST with
  one id → populate the editable subject/body via `parseDraft`.
- **Bulk:** a **"Draft selected"** action on the florist table's multi-select
  toolbar. If the table lacks row-selection today, add a lightweight checkbox
  selection (bounded to 25 to match the route). Shows per-florist success/failure.

### Out of scope for Phase 0
- Per-draft cost attribution to a job (on-demand drafts aren't job-scoped). May
  log token usage; no `ingest_jobs` accounting.

---

## Feature B — Multi-city input

### Goal

Submit a **list** of cities in one action instead of one city at a time. Each
city becomes an independent queued job the poller runs (queue mode) — the same
mechanism that becomes one-Workflow-per-city in Phase 2.

### Changes

**1. `POST /api/ingest` contract — accept a list:**
- Canonical body: `{ cities: [{ country, city }, ...], radius, limit, resetExisting }`.
  `radius`/`limit` are **shared across the batch**; `keywords`/`language` are
  **omitted** — the pipeline derives localized keywords per-country (queue mode
  already supports `keywords: null`; spawn mode's CLI derives when `--keywords`
  is omitted). Keep accepting the legacy single `{ country, city, ... }` body by
  wrapping it into a one-element `cities` list (only our own UI calls this route).
- Validation: `cities` length `1..50`; each `country`/`city` trimmed, non-empty,
  `≤ MAX_STRING_LEN`. **Dedup within the submitted list** (case-insensitive on
  `(country, city)`). `radius`/`limit` validated with the existing bounds.
- **Per-city duplicate guard:** reuse the existing check against
  `ingest_jobs` rows in `('queued','running')` for each `(country, city)`; a city
  already pending is **skipped, not rejected** — it must not fail the whole batch.
- **Enqueue:** queue mode inserts one `ingest_jobs` row per surviving city (each
  its own `id`), via the service client, exactly like today. Spawn mode (local
  dev only) loops and spawns each CLI run, best-effort.
- **Response:** `{ enqueued: [{country, city, jobId}], skipped: [{country, city, reason}] }`
  so the UI reports precisely what happened (enqueued vs. already-running vs.
  duplicate-in-list). Batch never 4xx's just because one city was a dup — only
  on a fully invalid body or empty result set.

**2. City-list parser (`dashboard/lib/cityList.ts`, unit-tested):**
- Input: raw textarea string. One city per line, `"Country, City"` (split on the
  **first** comma). Trim; skip blank lines; a line with no comma → collected into
  an `errors` list (reported, not silently dropped). Dedup case-insensitively.
- Output: `{ cities: [{country, city}], errors: [{line, reason}] }`.
- Country is passed through verbatim (name or code — the CLI's
  `normalize_country`/`pycountry` handles both).

**3. UI — paste-one-per-line (`AddCityDialog`/`AddCityForm`):**
- Replace the batch-entry path with a **textarea** ("Country, City — one per
  line") plus shared **radius** and **limit** inputs and the existing
  `resetExisting` toggle. Drop the per-city keyword-chip + language controls from
  this flow (keywords are derived per-country). Parse client-side via
  `lib/cityList.ts`; show parse errors inline before submit; POST once; render the
  enqueued/skipped summary. The single-city `RerunCityButton` path is unchanged.

### Out of scope for Phase 0
- Per-city radius/limit overrides (batch uses shared values; the structured
  per-row form was explicitly not chosen).
- Any change to how the poller claims/runs jobs — N rows already "just work."

---

## Verification (both features)

Per `CLAUDE.md`, exercise in a real browser (chrome-devtools-mcp available) —
don't claim it works without running it:
- **Drafting:** click "Draft email" on a florist with no draft → draft appears,
  parses into subject/body, is sendable; "Regenerate" overwrites; "Draft
  selected" over 3 florists returns 3 results incl. a forced failure case; re-run
  an ingest for that city and confirm the drafts **survive** (the `_build_row`
  fix).
- **Multi-city:** paste 4 cities incl. one already queued and one malformed line
  → response shows 3 enqueued, 1 skipped (already running), 1 parse error; 3
  `queued` rows appear in the jobs panel and the poller runs them.
- **Unit:** `cityList.ts` parser (dedup / blank / no-comma / first-comma split)
  and the `resolve_target_language` TS port. `parseDraft` round-trip already
  covered.

## Files touched (anticipated)

- `ingest/main.py` — remove draft call, counter, and `drafted_email` from
  `_build_row`.
- `dashboard/lib/draftEmail.ts` (new), `dashboard/lib/cityList.ts` (new).
- `dashboard/app/api/florists/draft-email/route.ts` (new).
- `dashboard/app/api/ingest/route.ts` — list contract + per-city guard/skip.
- `dashboard/components/{AddCityDialog,AddCityForm}.tsx` — paste UI.
- `dashboard/components/{OutreachSendPanel,FloristTable}.tsx` — draft/regenerate +
  bulk "draft selected".
- `dashboard/package.json` — add `@anthropic-ai/sdk`.
- Secret: `ANTHROPIC_API_KEY` on the Worker + local env.
