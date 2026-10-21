# Florist relevance filter

Date: 2026-08-03. Ingest currently applies **zero** filtering on whether a scraped
Google Maps place is actually a florist. Every result the Apify localized-keyword
search returns (`ingest/scrape.py`) — a real florist, a supermarket with a flower
counter, a gift shop, a garden center, a flower wholesaler, a wedding planner,
whatever matched "florist"/"floristería"/etc. as a text search term — gets a bare row
persisted and then the full enrichment treatment: a multi-page crawl plus up to three
Claude calls (ecommerce classification on Sonnet-5, email/phone/owner-name on
Haiku 4.5). This both pollutes the dashboard with non-florists and pays full
enrichment cost on results that should never have been considered.

This spec adds a relevance-filter step that drops non-florists **before** they're
persisted or enriched, using a free signal Apify already returns but the pipeline
currently discards (Google's own Maps category for the place), with a Claude fallback
only for genuinely ambiguous cases.

## 1. Pipeline placement

In `main.py`, today's order is: scrape → drop excluded place_ids → compute distance →
persist bare rows → enrich. The relevance filter is inserted as a new step immediately
after the excluded-place-id filter and before distance/persist:

```
[1] geocode → [2] resolve keywords → [3] scrape Apify → [3a] drop excluded place_ids
  → [3b] relevance filter (NEW)  → [4] compute distance → [5] persist bare rows
  → [6] enrich → [7] done
```

Step numbering in the CLI's progress echoes (`_echo`) shifts from `[1/7]`–`[7/7]` to
`[1/8]`–`[8/8]` to account for the new step.

A place that fails the relevance filter never gets a distance computed, never gets a
bare row written, and is never crawled or enriched — it simply does not exist in that
run's output. Nothing is persisted for it, matching the existing `excluded_at`
denylist's "never even scraped again" spirit (though relevance filtering re-evaluates
every run, since it's not a permanent user decision — a Maps category can change, or
the fallback classification could go either way on a re-run).

**Cleaning up already-ingested cities:** since ingest is idempotent and upsert-only, a
plain re-run does not remove rows that were already persisted before this filter
existed. Re-running `main.py --country ... --city ... --reset-existing` soft-deletes
the city's existing florists and re-scrapes from scratch, which applies the new filter
to everything found. No separate backfill script is needed.

## 2. Capturing the free signal

`ingest/scrape.py`'s `scrape_florists` normalizes each Apify item into a dict but
currently drops the actor's `categoryName` (primary category, localized to the
search's `language`) and `categories` (full list of categories Google assigned,
localized) fields entirely. Both are added to the normalized dict as transient keys —
`category_name` and `categories` — the same treatment `maps_online_order` already gets:
consumed by downstream logic, never persisted as their own `florists` columns.

## 3. Classification logic — `ingest/relevance.py` (new module)

```python
def category_matches_florist(category_name, categories, keyword_list) -> bool:
    """Case-insensitive substring match of category_name/categories against the
    country's already-resolved localized search keyword list (the same list
    keywords.py derives per-country, e.g. ["florist", "floristeria", "floristería"]
    for Spain). Reuses existing per-country localization — no new translation
    data needed."""
```

- **Match** (categoryName or any entry in categories contains one of the keyword
  strings as a substring) → keep, zero marginal cost. This is the common case: a
  genuine florist search hit is normally Maps-categorized as "Florist" (or its
  localized equivalent), which is exactly what's in that country's keyword list.
- **No match** (wrong category — "Supermarket", "Gift shop", "Garden center",
  "Wholesaler", "Wedding planner", etc. — or no category returned at all) → ambiguous,
  falls back to a Claude call.

### Claude fallback

New `RelevanceClassification` response model + `RELEVANCE_CLASSIFICATION_PROMPT` in
`prompts.py`, alongside the existing ones:

```python
class RelevanceClassification(BaseModel):
    is_florist: bool
    confidence: float
    reasoning: str
```

Input context: name, address, Maps categoryName/categories, rating, review_count (all
already in hand from the scrape — no extra fetch). The prompt is explicitly biased
toward keeping when genuinely uncertain: a drop here is **silent and permanent** (per
§1, nothing is persisted for a dropped place), so a false negative (real florist
misclassified as non-florist) is much costlier than a false positive (an occasional
non-florist that slips through gets caught downstream the same way it is today — a
human reviewing the dashboard, or simply low signal in enrichment).

**Model: `claude-sonnet-5`.** This is a business-type judgment call (closer in kind to
the existing ecommerce is-this-a-store classification, which stays on Sonnet per
`CLAUDE.md`'s documented per-call-type routing) rather than a mechanical
extraction/selection task. Since it only fires on already-rare ambiguous cases (most
results resolve for free via the category-rule match), the cost delta vs. Haiku is
negligible — favor accuracy given drops are irreversible. Add `"relevance"` to
`usage.py`'s `CALL_TYPES` and route it to `claude-sonnet-5` in `MODEL_FOR_CALL`, tracked
in `llm_cost_by_type` like every other call type. (Consistent with the project's
existing process, this can be revisited and moved to Haiku later if a spot-check shows
parity — same as owner-name was.)

### Orchestration

```python
async def filter_florists_by_relevance(
    florists: list[dict], keyword_list: list[str], claude_client, tracker
) -> tuple[list[dict], list[dict]]:
    """Returns (kept, dropped). Rule match is free and synchronous; ambiguous
    cases run concurrently through the Claude fallback, bounded by a semaphore
    (mirrors enrich.py's MAX_CONCURRENT_ENRICHMENTS pattern) since a single
    ingest run can have many ambiguous places to classify at once."""
```

Called from `main.py` via its own `asyncio.run(...)`, before the existing
`asyncio.run(enrich_all(...))` — kept separate rather than folded into
`enrich_florist` because relevance must be resolved **before** the bare-row persist
step (§1), which happens earlier in `main.py` than enrichment does.

## 4. Visibility

Nothing is persisted about a dropped place (per the "drop before persisting" decision),
but silent-forever filtering with no audit trail would make it hard to sanity-check or
tune. `main.py` echoes a progress line after the filter runs:

```
      Filtered N place(s) that didn't look like florists (category mismatch / Claude judged non-florist).
      e.g.: "Carrefour Express" (Supermarket), "Vila Regal" (Gift shop, Claude: no — home décor store, confidence 0.91), ...
```

Capped at ~10 examples (name + category +, for Claude-fallback drops, the reasoning) so
a large run doesn't flood the log; the full count is always shown. This goes through
the existing `_echo` helper (stdout + `ingest_jobs.last_line` when run from the
dashboard), not a new persistence mechanism.

## 5. Cost impact

Today, a non-florist keyword-search hit costs: a bounded multi-page crawl (up to 8
page fetches, some headlessly rendered) + an ecommerce Sonnet call + email/phone/owner
Haiku calls — the full enrichment bill, wasted. Under this design, the same place is
caught either for free (category rule, the common case) or with one small Sonnet
classification call using data already in hand (no crawl at all). This is a strict cost
reduction on every result the filter catches, on top of the data-quality improvement
that was the original ask.

## 6. Testing

A small `test_relevance.py`, mirroring the project's existing lightweight-test
convention (`test_email_regex.py`, `test_usage.py`): sanity assertions on
`category_matches_florist` — matches "Florist"/"Floristería" against a Spain-style
keyword list, rejects "Supermarket"/"Gift shop", handles an empty/missing category
list. No test coverage for the Claude fallback itself (consistent with the project's
existing non-goal of not testing LLM call correctness beyond scoring-math sanity
checks) — verified instead by running ingest against a real city and spot-checking the
filtered-examples log line.

## 8. Also ported to ingest-worker/

This spec was written when the feature was believed to be Python-only. Mid-review it
was discovered that `ingest-worker/` — a parallel TypeScript Cloudflare Worker that
reimplements the same ingest pipeline, also owns Shopify/order-matching, and is the
believed production job-claimer via its per-minute cron — needed the identical filter,
since it scrapes and enriches florists independently of `ingest/`. The same two-stage
design (free category-rule match, Claude fallback for ambiguous cases, fail-open on
error) and the same already-vouched-lifecycle-stage guard were ported there as
`ingest-worker/src/relevance.ts`, wired into the `CityIngestWorkflow` step orchestration
in `ingest-worker/src/workflow.ts`. The port was verified via its unit tests
(`relevance.test.ts`) and a clean `tsc` typecheck; whoever confirms a live Cloudflare
Workflow run against a real city should add that verification note here, since it was
not observed as part of this port.

## 7. Out of scope

- No new `florists` table column for category or relevance verdict — transient scrape
  fields only (§2), matching `maps_online_order`'s existing treatment.
- No backfill script — `--reset-existing` (§1) already covers cleaning up previously
  ingested cities.
- No dashboard UI changes — this is purely an ingest-side filter.
