---
id: oracle
nick: Oracle
emoji: 🔮
name: Stats chat
system: staff
stage: auto
prompt_source: code
model: app_settings.stats_chat_model
switch: staff role ops or admin
entry: dashboard/lib/statsChat.ts#chatWithStats
call_sites:
  - dashboard/lib/statsChat.ts
---

## Job

Answer staff questions about the data on the Statistics page.

## Rules

Still in code. Read-only SQL only, at most 5 rounds, 500 rows per query.

## Sees by default

A description of 15 tables and the chat so far.

## Can fetch on demand

`run_sql`, checked by `isReadOnlySelect` and run as the `stats_reader` role.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### answers-finish
- Means: Oracle answers the staff question within its 5 rounds, with no error and without the "I wasn't able to finish answering that" line.
- Data: Langfuse `oracle.run` traces; a trace counts when it has no level ERROR and its output is not the give-up line in `dashboard/lib/statsChat.ts`.
- Minimum: at least 90%
- Window: rolling 7 days, at least 10 cases
- Kind: decides
- Measurable: now, garden only. Production keeps no record of a stats-chat turn.

### staff-agreement
- Means: Staff mark Oracle's answer as right.
- Data: `operator_decisions` rows for oracle (marked right = agree, marked wrong = disagree).
- Minimum: at least 90%
- Window: rolling 30 days, at least 10 cases
- Kind: decides
- Measurable: not measurable yet: needs a right/wrong button on the Statistics chat that writes to `operator_decisions`.
