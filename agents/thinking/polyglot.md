---
id: polyglot
nick: Polyglot
emoji: 🗣️
name: Message template translation
system: staff
stage: draft
prompt_source: code
model: anthropic/claude-sonnet-5
switch: staff click on /messages
entry: dashboard/app/api/messages/translate/route.ts#POST
call_sites:
  - dashboard/app/api/messages/translate/route.ts
---

## Job

Draft the five non-English versions of a message template. They stay drafts
until staff approve them.

## Rules

Still in code. `judgeTranslations` checks placeholders and SMS-safe characters.

## Sees by default

The English template.

## Can fetch on demand

Nothing.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### published-unchanged
- Means: Staff publish Polyglot's draft translation as written. Published unchanged is agreement, edited is disagreement.
- Data: `operator_decisions` rows for polyglot, written on publish: a draft that still carries `ai_context` in `message_override_drafts` is agreement, one a person edited (`ai_context` cleared) is disagreement.
- Minimum: at least 90%
- Window: rolling 30 days, at least 5 cases
- Kind: decides
- Measurable: not measurable yet: needs the publish step to write it. Publish deletes the draft rows and `message_overrides.updated_by` names the publisher, so the fact is lost today.

### drafts-pass-check
- Means: Of the locales Polyglot drafts, the share that passes `judgeTranslations` (placeholders kept, SMS-safe characters).
- Data: Langfuse `polyglot.run` traces (the model's reply), judged again with `judgeTranslations` from `dashboard/lib/messages/translate.ts`; a locale with no reasons counts as passed.
- Minimum: at least 95%
- Window: rolling 30 days, at least 10 cases
- Kind: decides
- Measurable: now, garden only, by replaying the check on the traced reply. Production needs the rejected locales stored; the route returns them and keeps nothing.
