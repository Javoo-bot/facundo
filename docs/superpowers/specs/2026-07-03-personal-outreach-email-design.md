# Personal Outreach Email — Design

**Date:** 2026-07-03
**Status:** Approved (pending spec review)
**Scope:** `ingest/` (enrichment + drafting), `supabase/schema.sql`, `dashboard/lib/types.ts`
(+ light florist-detail surfacing)

## Goal

Make each generated outreach email feel individually researched and human, rather than a
fixed template stamped with a rating. Two levers, combined:

1. **A specific, researched detail** about the shop (drawn from its own About/team text).
2. **A warmer, less-templated tone**, addressed naturally — with correct greeting fallback
   when we don't confidently know the owner.

Plus two localization requirements added during brainstorming:

3. **Localize** the email to the shop's own website language, falling back to the most
   common language of the region.
4. **Always append an English version** at the bottom when the localized email is not in
   English.

## Non-goals

Zero extra LLM calls (reuse the existing owner-name call). Honest-nullable fields (no
fabrication). No new tests beyond a sanity check. No production outreach — drafts are
stored only, per the POC brief.

## Current state

- `EMAIL_DRAFT_PROMPT` (`ingest/prompts.py`) is a fixed template personalized on only
  `name`, `owner_name` (greeting), `rating`, `review_count`, `has_ecommerce`.
- The email is drafted in `finalize()` (`ingest/main.py`), which only sees the **distilled**
  enrichment fields returned by `enrich_florist` — the crawled About/team page text is
  consumed by owner-name extraction and then discarded.
- `extract_owner_name` (`ingest/enrich.py`) already makes a Sonnet-5 structured-output call
  over exactly that About/team/impressum text and returns `OwnerName{owner_name}`.
- The region's Google Maps `language` code (e.g. `es`, `ca`, `pt-BR`) is resolved per run
  and is in scope in `main()` where drafting happens.
- Dashboard reads florists with `select("*")`, so a new column flows through automatically;
  `types.ts` lists fields explicitly.

## Design

### 1. Extend the owner-name call → `shop_highlight` + `content_language` (no new LLM call)

Rename `OwnerName` → `OwnerInfo` (imported only in `enrich.py` and `prompts.py`):

```python
class OwnerInfo(BaseModel):
    owner_name: str | None
    shop_highlight: str | None      # one short, factual, distinctive detail; null if none
    content_language: str | None    # BCP-47 code of the shop's own text, e.g. "es", "ca"; null if undetermined
```

Update the prompt (rename `OWNER_NAME_PROMPT` → `OWNER_INFO_PROMPT`) to ask for all three
from the same About/team text:

- `owner_name` — unchanged rules; **null unless the text clearly names an owner/founder**
  (a real personal name, not a brand/staff/testimonial mention).
- `shop_highlight` — one short, factual, *specific* detail the shop states about itself
  (years in business, family-run, signature specialty, a notable award/recognition), drawn
  **only** from the page text. `null` if nothing genuinely distinctive. No fabrication.
  Stored as a neutral factual phrase (English is fine); the draft step rephrases it naturally
  in the target language.
- `content_language` — the BCP-47 language code of the shop's *own* website text. `null` if
  undetermined (e.g. too little text).

`extract_owner_name` → `extract_owner_info` returns `OwnerInfo`; still one Sonnet-5 call,
still cached on `("owner", text)`. `enrich_florist` returns `shop_highlight` and
`content_language` in its result dict (all null-branches — no website, no pages, extraction
failure — include both as `None`).

### 2. Persist `shop_highlight`

- `supabase/schema.sql`: add `shop_highlight text` (nullable) to `florists`, with the
  `alter table florists add column shop_highlight text;` migration noted for the existing DB.
- `_build_row` (`main.py`) includes `shop_highlight`; `_build_bare_row` leaves it null.
- `content_language` is **not** persisted — it's transient input to drafting, threaded
  through the in-memory florist dict via `finalize()`.

### 3. Rewrite the draft (tone + detail + localization + greeting fallback)

`_draft_outreach_email(claude, florist, city, region_language)`:

- **Target language resolution:** `florist["content_language"]` (the shop's own site
  language) → else `region_language` (the run's Maps language code) → else English.
- Pass `shop_highlight`, `owner_name`, and the resolved target language into the prompt.

New `EMAIL_DRAFT_PROMPT` instructions:

- **Write the whole email in the target language.** If the target language is **not**
  English, append a clear divider and a faithful **English version** below the localized one.
  If it *is* English, output only the one email.
- **Greeting fallback:** address the owner by name **only** if `owner_name` is provided and
  is clearly a real personal name; otherwise use a warm, natural greeting appropriate to the
  language (addressing the shop/team) — never a literal placeholder like `{name_or_owner}`.
- **Personal detail:** when `shop_highlight` is present, open by referencing that specific
  detail, phrased naturally in the target language. When it's null, fall back to today's
  rating/review opener.
- Keep it warm and human (not templated), concise (~120 words per language), one CTA, no
  invented details, no literal placeholders.
- **Subject-line contract:** the draft must start with a literal `Subject:` line (the ASCII
  label stays English so `dashboard/lib/outreach.ts::parseDraft` can split it), followed by
  the subject *text* in the target language. Without this the send panel silently falls back
  to a generic subject.

### 4. Dashboard (light)

- Add `shop_highlight: string | null` to the `Florist` type in `dashboard/lib/types.ts`.
- Surface `shop_highlight` near `owner_name` on the florist **detail** view so the researched
  hook is visible. (Draft rendering already works via `drafted_email`; the appended English
  version is just part of that text.)

## Data flow

```
crawl_site → pages ──► extract_owner_info (Sonnet-5, 1 call)
                          └─► owner_name, shop_highlight, content_language
                                     │
enrich_florist returns {..., shop_highlight, content_language}
                                     │
finalize(florist, enrichment):
   target_lang = content_language or region_language or "en"
   _draft_outreach_email(claude, florist, city, region_language)
       → localized email (+ English version if target_lang != en)
   _build_row persists shop_highlight (content_language is transient)
```

## Verification (POC checklist)

- Run ingest against a small real non-English city (e.g. a Spanish/Catalan city) plus one
  English-language check.
- Confirm `shop_highlight` populates where About text exists and is `null` otherwise.
- Confirm drafts: (a) reference the highlight when present; (b) fall back cleanly to the
  rating opener when null; (c) are written in the shop's language, with an English version
  appended when non-English; (d) use a correct greeting when `owner_name` is null/ambiguous
  (no `{placeholder}` leakage).
- Re-run the same city and confirm the row count is stable (idempotent upsert).

## Edge cases

- **No owner name / ambiguous name** → warm generic localized greeting; never a placeholder.
- **No highlight** → rating/review opener (today's behavior), still in the target language.
- **No About page / no website** → `shop_highlight` and `content_language` null; email falls
  back to region language + rating opener.
- **`content_language` disagrees with region** → prefer the shop's own site language.
- **Target language is English** → single email, no appended translation.
