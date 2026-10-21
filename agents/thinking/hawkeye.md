---
id: hawkeye
nick: Hawkeye
emoji: 📸
name: Delivery photo check
system: production
stage: auto
prompt_source: code
model: anthropic/claude-sonnet-5 + gemini-2.5-flash (votes), gemini-2.5-pro + qwen3-vl (shadow)
switch: app_settings.photo_verify_claude, photo_verify_gemini, photo_verify_openrouter
entry: dashboard/lib/photoVerify/index.ts#verifyDeliveryPhoto
call_sites:
  - dashboard/lib/photoVerify/claude.ts
  - dashboard/lib/photoVerify/gemini.ts
  - dashboard/lib/photoVerify/openrouter.ts
---

## Job

Decide whether the delivery photo shows what was ordered, so a clear miss
reaches a person.

## Rules

Still in code. Any low-confidence read, partial read or disagreement between
the voters means review, never pass.

## Checked by code, whatever this file says

`combineVerdicts` with a 0.7 confidence floor. A `review`/`fail` verdict no
longer holds the 30% — that stopped on 2026-08-20, pending recalibration,
after an audit found the check wasn't trustworthy enough yet to gate real
money on (`dashboard/lib/payoutHold.ts`). The payout now goes out the same way
regardless of the verdict. What the verdict DOES still do: raise a row on the
staff CX attention desk so a person sees it
(`dashboard/lib/cxAttentionRules.ts#photoVerdictAttentionReasons`) — before
2026-10-14 nothing did, so a `review`/`fail` read sat in `photo_verifications`
unseen unless staff happened to open that order's page.

## Sees by default

The photo and the order's line items. The shadow voters also see up to four
product images.

## Can fetch on demand

Nothing.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### person-agreement
- Means: A person who looks at the delivery photo reaches the same verdict as Hawkeye: pass when it shows the order, review or fail when it does not or cannot tell.
- Data: `operator_decisions` rows for hawkeye, against the latest `photo_verifications.verdict` for the assignment.
- Minimum: at least 95%
- Window: rolling 2 days, at least 20 cases
- Kind: decides
- Measurable: not measurable yet: needs `operator_decisions` to record the person's verdict when they clear the photo row on the CX desk, plus a small sample of pass verdicts shown to a person, since the desk only shows review and fail. Nothing stores a person's photo verdict today.

### planted-bad-photo-caught
- Means: In the garden, a photo planted as wrong (a screenshot instead of the bouquet) is never passed.
- Data: `garden_scenarios` with `expected.photo_verdict` set, joined to `photo_verifications.verdict` on the scenario's `order_id`; it counts as caught when the verdict is in the expected list.
- Minimum: at least 100%
- Window: rolling 7 days, at least 2 cases
- Kind: decides
- Measurable: now, garden only (the deliver-bad-photo scenario in `agents/garden/weather-catalogue.mjs`).

### planted-good-photo-passed
- Means: In the garden, the real bouquet photo passes, so people are not sent to look at good deliveries.
- Data: `garden_scenarios` whose `expected.steps` upload the bouquet photo (`photo` bouquet), joined to `photo_verifications.verdict` on the scenario's `order_id`; it counts when the verdict is pass.
- Minimum: at least 90%
- Window: rolling 2 days, at least 10 cases
- Kind: decides
- Measurable: now, garden only.
