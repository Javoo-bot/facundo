---
id: bloom
nick: Bloom
emoji: 🌷
name: Is this a florist?
system: recruiting
stage: auto
prompt_source: code
model: anthropic/claude-sonnet-5
switch: none
entry: ingest-worker/src/relevance.ts#classifyRelevance
call_sites:
  - ingest-worker/src/relevance.ts
---

## Job

Decide whether a place found on the map is really a florist, after the free
rules could not decide.

## Rules

Still in code. A single failed call keeps the place; too many failures stop
the run.

## Sees by default

Name, address, categories, rating and review count.

## Can fetch on demand

Nothing.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### person-agreement
- Means: A person checking a sample of Bloom's keep and drop decisions agrees with it.
- Data: `operator_decisions` rows for bloom (agrees = agree, overturns = disagree).
- Minimum: at least 95%
- Window: rolling 7 days, at least 20 cases
- Kind: decides
- Measurable: not measurable yet: needs the dropped places stored (today only up to 10 drop reasons per job reach `ingest_jobs.log`) and a person's verdict on a sample in `operator_decisions`.

### calls-answered
- Means: Bloom's call returns a verdict. A failed call keeps the place unjudged.
- Data: Langfuse `bloom.run` traces; a trace without level ERROR counts as answered. A malformed answer is kept too but is not an ERROR, so it is not counted here.
- Minimum: at least 95%
- Window: rolling 2 days, at least 20 cases
- Kind: decides
- Measurable: now, garden only. In production the only record is the "WARNING: N relevance call(s) failed" line in `ingest_jobs.log`, with no count of attempts, so it needs the judged and failed counts stored on `ingest_jobs`.
