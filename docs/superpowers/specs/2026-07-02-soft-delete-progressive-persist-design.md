# Soft-delete via delete-first re-run + progressive persist

Date: 2026-07-02. Two coupled changes to the ingest pipeline and the re-run flow:

1. **Soft-delete** all florists of a city, surfaced only through the re-run flow: a
   re-run can optionally delete the city's existing florists first (soft delete,
   cascade = all florists of that city). Deleted rows are hidden, not erased.
2. **Progressive persist**: the pipeline stops doing scrape → enrich-everything →
   upsert-once. Instead it persists bare scraped rows immediately (~30s in), then
   enriches + drafts + updates each florist in place, concurrently. Data lands early and
   survives a mid-run crash.

Both live in the ingest CLI (service-role writes) and the dashboard re-run UI. Scoring,
spread, cost tracking, and the enrichment logic itself are unchanged.

## 1. Data model

`florists` gains one nullable column; `null` = active, non-null = soft-deleted.

```sql
alter table florists add column if not exists deleted_at timestamptz;
```

- Migration file + `supabase/schema.sql` parity. No index (POC scale, a few hundred rows).
- `cities` unchanged. `unique (city_id, place_id)` unchanged — soft-deleted rows keep
  their `place_id`, so a returning florist upserts onto its existing row (no duplicate).
- **RLS unchanged.** Filtering is done at the query level (below), not in RLS, so deleted
  rows stay readable by the service role / raw SQL for recovery (matches "no restore UI,
  recoverable via SQL").

## 2. Read filtering (dashboard)

The two florist reads add `.is("deleted_at", null)`:
- `dashboard/app/page.tsx:42` — overview florist query.
- `dashboard/app/city/[id]/page.tsx:~93` — city florist query.

Stats/counts (`lib/stats.ts`) compute from the fetched rows, so excluding deleted at the
query level excludes them everywhere downstream — no stats-logic change.

## 3. Soft-delete + resurrection (ingest)

- **New `db.py::soft_delete_city_florists(client, city_id) -> int`** — sets
  `deleted_at = now()` for all currently-active florists of the city, returns the count.
  ```python
  def soft_delete_city_florists(client: Client, city_id: str) -> int:
      resp = (
          client.table("florists")
          .update({"deleted_at": datetime.now(timezone.utc).isoformat()})
          .eq("city_id", city_id)
          .is_("deleted_at", "null")
          .execute()
      )
      return len(resp.data or [])
  ```
- **Resurrection**: every upserted florist row (bare and full) includes `"deleted_at":
  None`. Because the upsert is on `(city_id, place_id)`, a florist that reappears in a
  scrape lands on its existing (possibly soft-deleted) row and clears `deleted_at`. A
  florist that does NOT reappear after a reset stays soft-deleted → clean slate. This
  also means a *normal* re-run auto-restores any previously-deleted florist that comes
  back, which is the correct, least-surprising behavior.

## 4. Progressive-persist pipeline (`main.py`)

Replaces the current `[1/7]…[7/7]` scrape → enrich-all → single upsert with a persist-
early, update-per-florist flow. New step labels:

1. `[1/7]` Geocode → `city_id` (+ `get_or_create_city`).
2. `[2/7]` **Reset (only if `--reset-existing`)**: `n = soft_delete_city_florists(db,
   city_id)`; echo `"Reset: soft-deleted {n} existing florist(s) before scraping."`.
   Runs BEFORE the scrape (delete-first, per decision). Trade-off accepted: a run that
   fails before the bare-persist step leaves the city empty until a successful re-run —
   surfaced in the confirm-dialog copy (§6).
3. `[3/7]` Resolve keywords → scrape → `florists`, capture `apify_cost_usd`.
4. `[4/7]` Compute `distance_km_from_center` per florist.
5. `[5/7]` **Persist bare rows**: `upsert_florists(db, [_build_bare_row(f, city_id,
   phone_region) for f in florists])` — maps-only fields + `deleted_at=None`, enrichment
   columns left null/default. The city is now queryable. Echo the count.
6. `[6/7]` **Per-florist enrich + draft + update, concurrent**:
   `asyncio.run(enrich_all(florists, claude, tracker, on_done=finalize))`. `enrich_all`
   fires `on_done(florist, enrichment)` as each florist's enrichment completes (see §5);
   `finalize` (defined in `main.py`) merges the enrichment, drafts the email if there's
   one (recording draft usage into `tracker`), and upserts that florist's FULL row
   (`_build_row`, `deleted_at=None`). Returning-after-reset florists resurrect here.
7. `[7/7]` Done. Echo the summary; `finish_job` records cost/timing/counts as today.

`florist_count` for the job = `len(florists)` (from the scrape), unchanged. The reset
count is informational (job log only), not a stored column.

## 5. `enrich_all` gains an `on_done` callback (`enrich.py`)

Keep the enrichment engine + browser/semaphore machinery in `enrich.py`; move drafting +
persistence to `main.py` via a callback so `enrich.py` stays free of DB/LLM-drafting
concerns.

```python
async def enrich_all(florists, claude_client, tracker=None, on_done=None) -> list[dict]:
    ...
    async def _run(f):
        e = await enrich_florist(f, http_client, browser, render_semaphore,
                                 claude_client, claude_cache, semaphore, tracker)
        if on_done is not None:
            await on_done(f, e)   # fires as THIS florist finishes, not at the barrier
        return e
    tasks = [_run(f) for f in florists]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ...
```

- `on_done` is `async (florist: dict, enrichment: dict) -> None`. It runs inside the
  per-florist task, so updates land progressively (not all at the final barrier).
- Existing `return_exceptions=True` behavior is preserved: if `enrich_florist` raises,
  that task's exception is captured in `results` and `on_done` is NOT called for it — but
  the bare row from step 5 is already persisted, so the florist stays visible. (An
  exception inside `on_done` itself likewise degrades to that florist's slot; the bare
  row remains.)
- `finalize` in `main.py` does the Supabase write via `asyncio.to_thread` (the client is
  sync); at most `MAX_CONCURRENT_ENRICHMENTS` (10) run at once, so ≤10 concurrent writes.

`main.py::finalize` shape:
```python
async def finalize(florist, enrichment):
    florist.update(enrichment)
    if florist.get("email"):
        text, response = _draft_outreach_email(claude, florist, city)
        florist["drafted_email"] = text
        tracker.record("draft", MODEL_FOR_CALL["draft"], response)
    else:
        florist["drafted_email"] = None
    row = _build_row(florist, city_id, phone_region)  # includes deleted_at=None
    await asyncio.to_thread(upsert_florists, db, [row])
```

## 6. Re-run UI (dashboard)

Both re-run entry points stop firing immediately and open a small confirm dialog first:
- `components/RerunCityButton.tsx` (city page).
- The overview row ↻ control in `components/CitiesTable.tsx`.

Confirm dialog (reuse the existing modal shell / styling; not a new design system):
> **Re-run {city}?**
> ☐ Delete the {N} existing florists first *(soft delete — they're hidden, not erased;
>   any that reappear come back. If the run fails before scraping finishes, the city
>   stays empty until a successful re-run.)*
> [Cancel] [Re-run]

- `{N}` = the city's current florist count, already available (overview city stats /
  city page `initialFlorists.length`). If unknown, omit the number ("existing florists").
- On confirm → `POST /api/ingest` with `resetExisting: <checkbox>`.
- Default unchecked (the safe, additive re-run).

## 7. `/api/ingest` route

- Accept and validate `resetExisting?: boolean` in the body (default `false`; reject a
  non-boolean). Same auth-gate + duplicate-guard as today.
- When `true`, append `--reset-existing` to the detached `spawn` args (fixed flag, no
  interpolation — same safety model as the other args).

## 8. `--reset-existing` CLI flag (`main.py`)

- `@click.option("--reset-existing", is_flag=True, default=False, help="Soft-delete the
  city's existing florists before scraping (they resurrect if they reappear).")`.
- Only the dashboard passes it; manual/terminal runs omit it and behave additively.

## 9. Edge cases

- Reset on a city with 0 existing florists → soft-deletes 0 rows, pipeline proceeds.
- Scrape returns 0 florists after a reset → bare-persist writes nothing; the city is
  legitimately empty (deleted + nothing new). Honest.
- A florist manually soft-deleted (via SQL) that reappears in a normal (no-reset) re-run
  → resurrected by the `deleted_at=None` upsert.
- Per-florist enrichment failure → bare row already visible; `finalize` still upserts the
  full row with `enrichment_notes` explaining the failure (enrich_all's `_FAILED_
  ENRICHMENT` path) — unless the task raised before returning, in which case the bare row
  simply stays as-is.
- Run crash after bare-persist → scraped rows persist (progressive-persist resilience);
  re-running (with or without reset) reconciles.

## 10. Verification

- Migration applied; `deleted_at` column live.
- Re-run a city **with** reset: during the run the city empties then repopulates; after,
  florists not in the new scrape are hidden, returning ones present, count reflects the
  fresh scrape. Confirm the bare rows appear early (query mid-run).
- Re-run **without** reset: additive upsert, nothing hidden.
- Manually `update florists set deleted_at=now()` one row, re-run without reset → it
  resurrects.
- Signed-out: no florist data leaks (RLS holds); deleted rows never appear in the
  dashboard.

## 11. Non-goals

No restore/trash UI. No standalone delete button (re-run prompt is the only surface). No
hard delete. No per-florist delete (whole-city only). No queues/microservices (the
per-florist fan-out is already concurrent; the wall-clock ceiling is the Apify scrape +
Anthropic rate limits, which more workers don't fix). No live city-page polling —
progressive persist makes data land early and survive crashes, visible on refresh; the
existing JobsPanel `router.refresh()` on job completion shows the final state. Live
per-florist streaming into an open city page is a possible cheap follow-up, not in scope.

## Build split

- **backend-engineer** → `ingest/` + `supabase/`: `deleted_at` migration + schema,
  `db.py::soft_delete_city_florists` + bare-row builder, `enrich.py::enrich_all` `on_done`
  callback, `main.py` progressive pipeline + `--reset-existing` + `finalize`, resurrection
  (`deleted_at=None` in all upserts).
- **frontend-engineer** → `dashboard/`: `.is("deleted_at", null)` on both florist reads,
  `/api/ingest` `resetExisting` validation + `--reset-existing` spawn arg, the re-run
  confirm dialog on `RerunCityButton` + the overview ↻.
