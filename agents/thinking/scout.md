---
id: scout
nick: Scout
emoji: 🔭
name: Search word suggestion
system: recruiting
stage: auto
prompt_source: code
model: claude-sonnet-5
switch: runs on a cache miss in country_keywords
entry: ingest-worker/src/keywords.ts#getKeywordsForCountry
call_sites:
  - ingest-worker/src/keywords.ts
---

## Job

Pick the words to search maps with for florists in a new country.

## Rules

Still in code.

## Known problem

The model name has no `anthropic/` prefix, so OpenRouter may reject it, and
its cost is not tracked.

## Sees by default

The country name.

## Can fetch on demand

Nothing.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### words-written
- Means: Every country an ingest runs for has search words, instead of the job failing at the keyword step.
- Data: `ingest_jobs` rows started in the window; a job counts when a `country_keywords` row exists for its country, normalised as `normalizeCountry` in `ingest-worker/src/keywords.ts`.
- Minimum: at least 100%
- Window: rolling 30 days, at least 1 case
- Kind: decides
- Measurable: now. This is the measure that would catch the known problem above.

### first-city-finds-florists
- Means: When Scout picks the words for a new country, the first city searched with them keeps at least 10 florists after the free rules and Bloom.
- Data: `country_keywords` rows with `ai_context` set (words Scout wrote), joined to that country's first `ingest_jobs` row with `status` succeeded; it counts when `florist_count` is at least 10.
- Minimum: at least 80%
- Window: rolling 30 days, at least 1 case
- Kind: decides
- Measurable: now. New countries are rare, hence 30 days; a small town can fall short for reasons that are not Scout's, which the deep analysis has to rule out.
