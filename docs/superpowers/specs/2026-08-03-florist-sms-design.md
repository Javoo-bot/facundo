# Florist SMS — order offers + recruiting outreach

**Date:** 2026-08-03 · **Status:** approved (directional), not yet started

## Problem

Every florist-facing message today goes out over email (Resend) or web push. Two gaps:

1. **Order offers have no third channel.** `lib/reachoutSend.ts::sendOffer()` sends email +
   web push together as a hedge. `lib/lifecycle.ts`'s `reachout-comms-fail` branch has
   carried `status: "open"` since Plan 2 with exactly this remedy named: *"Add WhatsApp/SMS
   as a third channel."* A florist with a bounced address and a dead push subscription is
   currently unreachable without CX phoning them.
2. **Recruiting outreach is email-only.** `outreach.channel` is DB-constrained to `'email'`.
   A florist whose scraped email is wrong or unmonitored can't be reached at all, even
   though we usually scraped a phone number for them too.

The schema already anticipates this work: `app_settings.test_phone` exists with the comment
`-- reserved for future SMS/WhatsApp`, and `florists.preferred_channel` allows `'whatsapp'`.
Neither is read by any code today.

**No SMS provider integration exists anywhere in the monorepo** — this is greenfield. Grep
for `twilio|messagebird|vonage|nexmo|sms` across `dashboard/` and `ingest/` returns only the
two placeholder references above.

## Decisions (locked)

- **One shared client, two consumers.** `lib/sms.ts::sendSms()` mirrors `lib/email.ts::sendEmail()`
  exactly (never throws, returns a discriminated result, double-logs to `external_ops` +
  `communications`). Order offers and recruiting outreach both call it.
- **Telnyx**, via a **messaging profile + alphanumeric sender ID** — see *Sender identity*.
  (Twilio was the original pick; switched before launch — see that section for what changed.)
- **One-way only.** No inbound webhook, no reply parsing, no `YES`/`NO` handling. The SMS
  carries a link to the same florist pages email and push already link to.
- **Scraped phone numbers used as-is.** No new verified-phone column, no OTP flow. Staff
  already edit `phone_web`/`phone_maps` through the florist-edit-details panel, so a bad
  number is correctable exactly like a bad email is today.
- **SMS is best-effort, never authoritative.** In `sendOffer()`, a failed SMS must not roll
  back the atomic assignment claim — it behaves like the existing push leg, not the email leg.

## Sender identity

`sendSms()` posts to Telnyx's `/v2/messages` with a **messaging profile ID** and an explicit
**alphanumeric sender ID** (`TELNYX_SENDER_ID`, e.g. `Facundo`) — the brand name the
florist sees instead of a number.

**This is a real narrowing versus the original Twilio design, and it is deliberate.** A Twilio
Messaging Service holds a pool of senders and picks one per destination country on the
provider's side, so no per-country logic lived in our code. Telnyx requires an explicit `from`
on every send, so **one sender is used for every destination**. That is correct today — the
shipped markets are ES/FR/IT/DE (`lib/i18n/locales.ts`), all of which accept alphanumeric
senders — but expanding to a country that forbids them would need per-country sender selection
added to `lib/sms.ts`. It is intentionally not built: there is no such market yet, and a
guessed mapping would be worse than none.

Telnyx was chosen over Twilio for materially better per-message economics at scale and because
Telnyx is a licensed carrier in many regions, which puts more of the sender-registration work
inside one portal. The switching cost was low by design — the provider surface is ~120 lines in
one file with a single call site — so this decision stays cheap to revisit.

**Account-setup constraints, to verify in the Telnyx portal — not code:**

- Alphanumeric sender IDs are **not** supported in the US/Canada, which require a registered
  10DLC or toll-free number. Not built (see above).
- Several European countries require **pre-registration** of alphanumeric sender IDs. The
  per-country rules change; confirm current requirements for ES/FR/IT/DE at signup rather than
  assuming. **This has lead time and is the long pole for launch** — start it early.

## Migrations

`supabase/migrations/2026-08-03-sms.sql`:

| change | detail |
|---|---|
| `communications.channel` | widen check to `('email','push','sms')` |
| `outreach.channel` | widen check to `('email','sms')` |
| `app_settings.sms_offer_enabled` | boolean not null default false |
| `app_settings.sms_recruiting_enabled` | boolean not null default false |
| `florists.order_sms_opt_out` | boolean not null default false |
| `florists.order_sms_snoozed_until` | timestamptz null |
| `florists.drafted_sms` | text null |

Both `sms_*_enabled` flags default **false** — SMS ships dark and is switched on from
Settings → Notifications, matching `shopify_writeback_enabled`'s precedent.

SMS opt-out is tracked **separately** from `order_emails_opt_out`: a florist may tolerate
texts while ignoring email, or the reverse, and conflating them would silently suppress a
channel they never opted out of.

Mirror every change into `supabase/schema.sql` (the repo keeps schema.sql and migrations in
step) and into the `Outreach` / `Florist` / `AppSettings` types in `lib/types.ts`.

## `lib/sms.ts` — the shared client

```
sendSms({ to, body, context }): Promise<{ ok: true; id: string } | { ok: false; error: string }>
```

Same contract as `sendEmail`: never throws, always logs. `context` carries
`orderId`/`operation`/`audience`/`kind`/`floristId`/`assignmentId`/`actor`/`testMode` —
identical to `SendEmailContext`, minus `subject` (SMS has none).

- `external_ops` row on **every** call: `provider: "telnyx"`, `operation` from context.
- `communications` row when `context.audience` **and** `context.kind` are set:
  `channel: "sms"`, `provider: "telnyx"`, `subject: null`.
- Missing `TELNYX_*` env → logs `failed` and returns `{ ok: false }`, same as `sendEmail`'s
  missing-`RESEND_API_KEY` path. No throw.

Env vars, following the `PROVIDER_*` convention and read via `process.env` inside this file:
`TELNYX_API_KEY`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_SENDER_ID`.
Authentication is a scoped, independently revocable **API key** (Bearer) rather
than an account-master credential, so a leak from this one send path can be cut
off without disturbing any other integration. Document in
`dashboard/.env.local.example` and `DEPLOY.md`.

## `lib/phone.ts` — number resolution

```
resolveFloristSmsPhone(florist, fallbackRegion): string | null
```

Prefers `phone_web`, falls back to `phone_maps`, normalizes to E.164 via `libphonenumber-js`
using the florist's city country as the default region — the same fallback-region pattern
`lib/offerVars.ts` already uses to resolve a null `locale`. Returns `null` for anything
unparseable (a landline is fine to return; we cannot reliably detect deliverability, and
Telnyx will report the failure).

`libphonenumber-js` is a **new dependency** — verified absent from `dashboard/package.json`.
It is the one addition this work makes; everything else reuses existing code. Hand-rolling
E.164 normalization across four countries' formatting conventions is not worth the bugs.

No `@/` imports, so it unit-tests under plain `node --test` per the `lib/reachoutSend.test.mjs`
convention.

## Consumer A — order-offer SMS

Third leg in `lib/reachoutSend.ts::sendOffer()`, placed alongside the existing
`sendPushToFlorist` call at the end, **after** the atomic claim, order-status update, and
`order_events` insert.

`lib/offerVars.ts::resolveOfferVars` gains SMS fields on `ResolvedOffer` — resolved in the
same single pass as the email fields, so the existing no-drift guarantee between preview and
send extends to SMS:

- `smsOfferEnabled` (from `app_settings.sms_offer_enabled`)
- `smsIntended` (E.164 from `resolveFloristSmsPhone`, or null)
- `smsTo` (`testMode ? app_settings.test_phone : smsIntended`)
- `floristSmsSuppressed` / `smsSuppressReason` (`opted-out` | `snoozed`)

`resolveOfferVars` must keep its **provable zero-write property** — the new SMS resolution is
read-only; nothing here mints or persists anything.

Skip-and-log cases, each writing a `communications` row with `status: "skipped"` and never
blocking the offer (mirroring how the email leg's skips already behave):

| condition | logged error |
|---|---|
| `sms_offer_enabled` off | `disabled-by-settings` |
| test mode with no valid `test_phone` | `no-test-phone` |
| no parseable florist number | `florist-no-sms-phone` |
| `order_sms_opt_out` / snoozed | `florist-sms-opted-out` / `florist-sms-snoozed` |

**A failed SMS send never calls `rollbackClaim`.** The email leg owns that behavior because
it is the authoritative channel; SMS and push are hedges. Getting this wrong would let a
Telnyx outage roll back offers that were successfully emailed.

**Content** — `lib/offerSmsContent.ts::buildOfferSmsContent(locale, overrides, vars)`, a plain
sibling of `buildOfferEmailContent`, reusing the same `loadOverrides`/locale resolution so
copy stays editable from `/email-templates` and localized per florist. No `@/` imports →
`node --test`-able.

New catalog keys (`sms.offer.*`) are added to `lib/i18n/messages/*.ts` and — for any key
taking `{var}` placeholders — registered in `lib/i18n/varsManifest.ts`. That manifest is
hand-maintained with nothing enforcing it automatically (per its own header comment), so
omitting the new keys silently disables the template editor's missing-variable warning for
every SMS string.

Target **one or two SMS segments** (≈160 GSM-7 chars per segment; accented ES/FR/IT/DE copy
may fall back to UCS-2 at 70 chars — the builder must be tested against real localized
strings, not English). Contents: delivery area, payout, reply window, a link to
`/florist/orders/[assignmentId]`, and the opt-out link.

## Consumer B — recruiting-outreach SMS

`lib/draftSms.ts` mirrors `lib/draftEmail.ts` — prompt-building only, no I/O, same
`shop_highlight` personalization, prompted for a short single-paragraph text with an explicit
length cap. Stored on `florists.drafted_sms`.

The LLM call lives in a new `app/api/florists/draft-sms/route.ts`, mirroring
`app/api/florists/draft-email/route.ts` including its `claude-sonnet-5` model constant —
drafting is judgment-bearing generation, the same class of call the email draft uses.

`app/api/outreach/send/route.ts` accepts `channel: "email" | "sms"` on the request body
(defaulting to `"email"`, so existing callers are unchanged). The per-item loop branches:
resolve phone instead of email, check `sms_recruiting_enabled` instead of
`email_recruiting_enabled`, call `sendSms` instead of `sendEmail`, insert `outreach` with
`channel: "sms"` and `subject: null`. Everything else — the auth gate, the server-authoritative
`test_mode` read, the `MAX_ITEMS` cap, the per-item error isolation, the `lifecycle_stage`
bump to `contacted` — is reused as-is.

`components/OutreachSendPanel.tsx` gains an email/SMS toggle. The existing safety UX is
preserved and must apply identically to SMS: test-mode banner always visible, live send behind
an explicit second "Confirm live send" click, and the client never sends `test_mode` (the
server always re-reads `app_settings`). The SMS composer shows a **live segment count**, since
a florist-facing cost and truncation risk rides on it.

## Opt-out and compliance

Every outbound SMS — offer and recruiting alike — ends with a short opt-out link reusing the
existing `/florist/unsubscribe/[token]` page, which gains an SMS-scoped option writing
`order_sms_opt_out` / `order_sms_snoozed_until`.

A link rather than "reply STOP" is a direct consequence of the one-way decision: with no
inbound webhook, a `STOP` reply would land nowhere, and an unhonored opt-out instruction is
worse than none. If two-way SMS is added later, `STOP` handling should be added at the same
time, not before.

Test-mode sends must reuse the existing **placeholder-token** protection from
`lib/offerVars.ts` — a staffer reviewing a test SMS must never be able to opt a real florist
out. The current implementation already routes test-mode unsubscribe URLs to
`/florist/unsubscribe/test-mode-preview`; SMS inherits this unchanged.

Telnyx account setup will likely require business-messaging registration (A2P 10DLC in the US,
alphanumeric sender registration in parts of Europe) for reliable delivery. Out of scope as
build work; called out so it is not discovered mid-rollout.

## Lifecycle map

`dashboard/lib/lifecycle.ts` is updated in the same change (per CLAUDE.md's standing rule):

- `reachout-comms-fail` moves from `status: "open"` / `milestone: "later"` to
  `status: "handled"` / `milestone: "mvp"`, with `handling` rewritten to describe the
  email + push + SMS hedge.
- A new sibling branch records the SMS-specific failure mode: a florist with **no parseable
  phone number**, handled by the skip-and-log path above and visible in the communications log.
- `reachout-send`'s `code` array gains `dashboard/lib/sms.ts`, `dashboard/lib/phone.ts`, and
  `dashboard/lib/offerSmsContent.ts`.

## Testing

Following the repo's lightweight `node --test` convention — pure logic only, no HTTP mocking:

- `lib/phone.test.mjs` — E.164 normalization across ES/FR/IT/DE formats, `phone_web` →
  `phone_maps` fallback order, unparseable input returning `null`, and a number already in
  E.164 passing through unchanged.
- `lib/offerSmsContent.test.mjs` — localized rendering for all five locales, override
  application, and **segment count assertions against the real localized strings** (the
  accented-character UCS-2 case is the one most likely to regress silently).

The Telnyx HTTP call itself is left untested, exactly as `lib/email.ts`'s Resend call is today.

**Manual verification before shipping** (per CLAUDE.md — no "should work" claims):
send a real test-mode offer SMS to `app_settings.test_phone`, confirm it arrives, confirm the
order link and opt-out link both resolve, and confirm a `communications` row with
`channel: "sms"` plus an `external_ops` row with `provider: "telnyx"` were both written.

## Out of scope

- Inbound SMS: replies, `STOP` parsing, delivery-status webhooks.
- WhatsApp (despite `preferred_channel` allowing it) — a separate product with its own
  template-approval regime.
- Reading or writing `florists.preferred_channel` to route channel selection. SMS is an
  additive hedge on every offer, not a per-florist channel preference. Wiring
  `preferred_channel` is a plausible follow-up once there is delivery data to justify it.
- Client-facing (buyer/recipient) SMS. `orders.buyer_phone` / `recipient_phone` exist but
  this work is florist-facing only.
- Any verified-phone or OTP flow.
