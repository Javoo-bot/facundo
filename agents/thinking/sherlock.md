---
id: sherlock
nick: Sherlock
emoji: 🕵️
name: Shop website reader
system: recruiting
stage: auto
prompt_source: code
model: anthropic/claude-sonnet-5 (online shop, owner) + anthropic/claude-haiku-4.5 (email, phone)
switch: none
entry: ingest-worker/src/enrich.ts#enrichFlorist
call_sites:
  - ingest-worker/src/enrich.ts
---

## Job

Read a shop's website and pick out whether it sells online, its real email
and phone, and the owner's name.

## Rules

Still in code. Unknown stays null, with the reason in `enrichment_notes`.

## Sees by default

Up to 6000 characters of the site for the online-shop check, 4000 around the
email and phone candidates, 8000 from the contact and about pages.

## Can fetch on demand

Nothing. The crawl happens before the model is called.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### contact-found
- Means: Of the shops with a website, the share where Sherlock (with the free rules before it) finds an email or a phone on the site.
- Data: `florists` with `has_website` true and `enrichment_notes` set (enrichment ran), by `ingested_at`; a shop counts when `email` or `phone_web` is not null.
- Minimum: at least 70%
- Window: rolling 2 days, at least 30 cases
- Kind: decides
- Measurable: now. `ingested_at` is when the shop was first found, so a repair run over old shops does not show in the window.

### email-delivers
- Means: The emails Sherlock picked are real: recruiting email sent to them does not bounce.
- Data: `outreach` rows with `channel` email, `status` sent and `test_mode` false, by `sent_at`, joined to `florists.email_bounced_at`; a send counts when there is no bounce.
- Minimum: at least 95%
- Window: rolling 7 days, at least 20 cases
- Kind: decides
- Measurable: now, production only. The garden sends everything to the test inbox, so nothing there bounces.
