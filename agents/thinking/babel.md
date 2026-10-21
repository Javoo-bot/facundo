---
id: babel
nick: Babel
emoji: 🌍
name: Order translation for florists
system: production
stage: auto
prompt_source: code
model: anthropic/claude-sonnet-5
switch: env OPENROUTER_TRANSLATION_MODEL
entry: dashboard/lib/translations/lineItems.ts#warmLineItemTranslations
call_sites:
  - dashboard/lib/translations/lineItems.ts
---

## Job

Translate the order's line items into the florist's language when an offer is
sent, for whatever Shopify's own translations don't cover.

## Rules

Still in code. Anything that fails the content check stays in English.

## Sees by default

Line item title, variant, bouquet spec, components and add-ons.

## Can fetch on demand

Nothing.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### translations-pass-check
- Means: Of the line-item texts Babel is asked to translate, the share that passes the content check and reaches the florist translated. A text that fails stays in English.
- Data: Langfuse `babel.run` traces (metadata `strings` is how many texts were asked for, the input is the prompt) against `content_translations` rows with `provider` llm whose `ai_context.prompt` is that prompt (the texts that passed). A call where everything failed leaves no rows and counts as none passed.
- Minimum: at least 98%
- Window: rolling 2 days, at least 50 cases
- Kind: decides
- Measurable: now, garden only. Production sends no Langfuse traces, so there it needs the rejected count stored next to the translations.
