---
id: quill
nick: Quill
emoji: ✍️
name: Outreach email writer
system: recruiting
stage: draft
prompt_source: code
model: anthropic/claude-sonnet-5
switch: env OPENROUTER_RECRUITING_MODEL
entry: dashboard/lib/recruitingPersonalise.ts#personaliseRecruitingEmail
call_sites:
  - dashboard/lib/recruitingPersonalise.ts
  - dashboard/app/api/florists/draft-email/route.ts
---

## Job

Personalise the recruiting email for one florist shop. Staff read every draft
before it is sent.

## Rules

Still in code (`lib/draftEmail.ts`). The catalog email goes in verbatim; on
any failure the plain catalog email is used.

## Sees by default

Shop name, rating, review count, owner name, shop highlight, city and language.

## Can fetch on demand

Nothing.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### sent-unchanged
- Means: Staff send Quill's draft as it is. Sent unchanged is agreement, edited is disagreement.
- Data: `operator_decisions` rows for quill when that table lands. Until then, `outreach` rows (`channel` email, `status` sent, by `sent_at`) against the florist's `drafted_email` split by `parseDraft` in `dashboard/lib/outreach.ts`, only where `drafted_email_context.personalised` is true; the same subject and body after trimming is agreement.
- Minimum: at least 80%
- Window: rolling 7 days, at least 10 cases
- Kind: decides
- Measurable: now, from the outreach stand-in. A re-draft after the send overwrites `drafted_email` and reads as an edit, so `operator_decisions` replaces it when it lands.

### personalised
- Means: Quill's call returns a usable draft, so the shop gets a personal email instead of the plain catalog one.
- Data: `florists.drafted_email_context.personalised` (true or false) for the florists emailed in the window (`outreach.sent_at`, `channel` email); rows where it is null had no model run and are not counted.
- Minimum: at least 95%
- Window: rolling 7 days, at least 10 cases
- Kind: decides
- Measurable: now.
