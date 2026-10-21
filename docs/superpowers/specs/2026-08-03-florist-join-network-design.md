# Florist "join our network" outreach + self-registration

Date: 2026-08-03. Extends the existing recruiting-email system with a public,
no-login "verify your details and join" form, so a florist we've discovered (in this
city or any future one we expand to) can confirm/correct their own info and set two
fields we don't have any other way to get: opening hours and a next-day-delivery
cutoff time. Everything the florist sees — the email and the form — is localized to
that florist's language.

## 1. Scope & framing

This is **not** a new outreach system. A recruiting-email pipeline already exists
end-to-end: `lib/draftEmail.ts` (LLM-drafted, personalized, already localized per
`resolveTargetLanguage`), `POST /api/outreach/send` (real Resend send, gated by
`app_settings`/`emailEnabled(..., "recruiting")` + `test_mode`), and an audit trail
(`outreach` + `communications` tables, `kind: "recruiting"`). This spec adds two
things on top of that:

1. A join-link CTA appended to the recruiting email.
2. The public accept/registration page + form the link points to, plus the two new
   fields it captures.

No new "prospect city" concept is introduced — every city is ingested the same way
today, in this city and any future one; this flow runs identically wherever ingest
runs.

**Reused, not duplicated:** florists already have a `business_hours jsonb` column
(free-form day-token → range-string map, e.g. `{"mon_fri":"09:00-20:00"}`), staff-
editable via `app/api/florists/operational/route.ts` and rendered via
`floristOps.ts::businessHoursLabel`/`dayLabel`. The registration form's hours grid
writes into this **same column** (see §3) instead of adding a parallel field — one
source of truth for hours, whether staff or the florist sets it. Likewise,
localization reuses the **existing** `florists.locale` column (already the driver for
localized order-offer emails via `lib/reachoutSend.ts` /
`lib/offerVars.ts::resolveFloristLocale`) rather than introducing a second
language-resolution mechanism alongside `draftEmail.ts`'s `resolveTargetLanguage`.

Visual reference (interactive, all 5 locales, all form states):
(internal mockup, not published)

## 2. Data model

New migration `supabase/migrations/2026-08-03-florist-join-network.sql`:

```sql
alter table florists
  add column if not exists join_token             text unique,
  add column if not exists join_token_expires_at   timestamptz,
  add column if not exists joined_at               timestamptz,
  add column if not exists next_day_cutoff_hour    integer;

alter table florists add constraint florists_next_day_cutoff_hour_check
  check (next_day_cutoff_hour is null or next_day_cutoff_hour in (11, 12, 13, 14, 15));
```

- `join_token` — opaque `randomUUID()`, minted lazily (see §4), same pattern as the
  existing `unsubscribe_token`. Unique so a token→florist lookup is a plain indexed
  equality query.
- `join_token_expires_at` — 30 days from mint (longer than the 7-day teammate-invite
  window, since a cold recruiting email may sit unopened far longer than an internal
  invite). Staff resending the recruiting email refreshes it (see §4).
- `joined_at` — null until the florist submits; non-null makes the link idempotent
  (§5 shows a read-only confirmation instead of the form on repeat visits).
- `next_day_cutoff_hour` — defaults to nothing at the DB level (stays null until the
  florist actually sets it, honest-nulls convention); the form pre-selects `13` as
  the UI default before submit, per product requirement.
- `business_hours` is **not** touched by this migration — already exists.

## 3. Operating-hours shape (writing into `business_hours`)

The form's 7-row grid (Mon–Sun, a "closed" toggle, open/close time per day, plus a
"same hours every day → Apply to all" convenience that just fills all 7 rows
client-side — no schema implication) serializes to the existing free-form jsonb
convention using individual day keys:

```json
{ "mon": "09:00-19:00", "tue": "09:00-19:00", "wed": "09:00-19:00",
  "thu": "09:00-19:00", "fri": "09:00-19:00", "sat": "10:00-14:00",
  "sun": "closed" }
```

- A day the florist never touches (times blank, "closed" unchecked) is **omitted**
  from the object entirely — never asserted open or closed. `businessHoursLabel`
  already filters non-string/empty values, so a partial week renders fine.
- Value is either the literal string `"closed"` or `"HH:MM-HH:MM"`.
- This is a strict subset of what `operational/route.ts` already accepts
  (`business_hours` there is validated only as "plain object or null" — no key/value
  shape enforced) — no change needed on that route. The accept-form's own submission
  route validates the day-key/value shape more strictly (see §5) since it's the one
  place untrusted, unauthenticated input writes into this column.
- If staff already set `business_hours` before the florist ever visits the link
  (rare but possible), the form pre-fills the grid from whatever day keys are
  present instead of starting blank.

## 4. Recruiting-email CTA

The LLM-authored body (`buildDraftPrompt`) is unchanged — no LLM-generated URL, to
avoid a model mangling a link or violating its own "no placeholders" instruction. A
fixed, localized template line is appended **server-side, inside the existing
`POST /api/florists/draft-email` route** — not a new endpoint. That route already
loops per-florist to call the LLM and persist `drafted_email`; minting/reusing the
join token and appending the CTA in the same loop means the stored draft is always
complete (no separate client round trip, and the table's existing "draft ready"
indicator and `OutreachSendPanel`'s textarea need zero changes):

- Per florist in `draftOne`: if `joined_at` is null, decide whether to mint a new
  token (`lib/floristJoin.ts::needsNewJoinToken` — true when none is set or the
  current one has expired; never true once already joined) or reuse the live one.
  A fresh mint is `randomUUID()` + `now() + 30d` (`joinTokenExpiry`), persisted
  immediately. Build the URL (`buildJoinUrl`) and append
  `t(resolveFloristLocale({locale: florist.locale}), "email.recruiting.ctaLine",
  {joinUrl})` to the LLM text before storing it in `drafted_email`. A florist who
  already joined gets no CTA appended at all.
- Staff can still edit or remove the appended line in the panel before sending,
  same as any other part of the draft — nothing about `/api/outreach/send` changes.
- No new `email_toggles`/`communications` `kind` — this rides on the existing
  `"recruiting"` kind end to end.

## 5. Public registration page

`dashboard/app/florist/accept/[token]/page.tsx` — a **new, distinct path** from the
existing `app/florist/join/page.tsx` (that one is the logged-in teammate-invite
acceptance flow; sharing the path would collide two unrelated features). Same trust
model as the existing no-login unsubscribe page: token possession is the only gate,
via the service-role client, no staff auth.

Server component looks up `florists` by `join_token`, reads `locale` directly off
the row (`resolveFloristLocale`) — no `?locale=` query param needed, unlike the
unsubscribe page, since this page always has the florist row in hand already:

- Token not found → generic localized "link not found" card.
- `join_token_expires_at` in the past and `joined_at` still null → localized
  "this link has expired, ask Facundo to resend" card.
- `joined_at` already set → localized read-only "you're already in the network ✓"
  card (idempotent re-visits, no re-submit).
- Otherwise → `FloristAcceptForm` client component, pre-filled and editable:
  `name`, `address`, `phone_web` (shown as the single "Phone" field — already the
  free-text, staff-editable phone column), `email`; the hours grid (§3, pre-filled
  from any existing `business_hours` keys, else blank); the cutoff selector
  (11:00/12:00/**13:00**/14:00/15:00, 13:00 pre-selected). One "Confirm & Join"
  submit.

All copy — labels, helper text, button, all three non-form states, the 7 day
abbreviations — comes from new `ui.accept.*` keys added to
`dashboard/lib/i18n/locales.ts` for all 5 already-supported locales (`en, fr, es, it,
de`), following the exact `t()`/`isLocale` pattern the unsubscribe page already uses.

## 6. Submission

`POST /api/florist/accept` — public, token-gated (not staff `requireRole`). Body:
`{ token, name, address, phone, email, business_hours, next_day_cutoff_hour }`.

New pure validation module `lib/floristAccept.ts` (mirrors the existing
`lib/floristDetails.ts` convention — pure functions, `node --test`, no framework):

- `name`: non-empty trimmed string (column is `not null`).
- `email`: `null` or the existing repo-wide permissive/unicode-tolerant pattern
  (`lib/offerVars.ts`'s `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`) — do not introduce a
  stricter check.
- `address`, `phone`: free-text, trimmed, empty → `null`.
- `business_hours`: object with only the 7 day keys (`mon`…`sun`), each value
  either `"closed"` or `HH:MM-HH:MM` with close-after-open; anything else → 400.
- `next_day_cutoff_hour`: one of `11,12,13,14,15`.

Route behavior:

- 404-equivalent / expired / already-joined guards mirror §5's page logic (checked
  again server-side — the page's state is not trusted as the sole gate).
- On success: updates `name`/`address`/`phone_web`/`email`/`business_hours`/
  `next_day_cutoff_hour`, sets `joined_at = now()`, inserts one `florist_notes` entry
  ("Florist self-registered via network-join link — confirmed contact details and
  hours."), and bumps `lifecycle_stage` to **`onboarding`** — only from an earlier
  stage (`found`/`targeted`/`contacted`/`engaged`, mirroring the existing
  `BUMP_TO_CONTACTED_FROM` guard shape), never downgrading a florist already further
  along.
- Deliberately **not** `production`: `lib/lifecycle.ts` already documents this exact
  failure mode as a cross-cutting risk — a florist marked `production` without a
  trust tier/delivery radius set can't actually receive an order. `onboarding`
  already makes them matchable today (`orders/assign` and `FloristPicker` both treat
  `onboarding`/`production` as equally "onboarded"), while correctly signaling to
  staff that a trust-tier/payout/delivery-radius pass is still owed before go-live.

## 7. `lib/lifecycle.ts` touch-point

This doesn't touch the Shopify-order fulfillment loop itself, but it feeds a
precondition that map already tracks. Add a one-line note to the existing branch at
`lib/lifecycle.ts:300` (the "marked production without trust tier/delivery radius"
risk) noting that self-registered florists deliberately land in `onboarding`
specifically to avoid that failure mode — no new node needed.

## 8. Testing

`node --test` for `lib/floristAccept.ts` (cutoff enum, `business_hours` shape/day-key
validation, expiry check, already-joined check) — this repo's existing lightweight
convention, no framework.

Manual verification: mint a join link for a real ingested florist via the outreach
panel, open it in each of the 5 locales (swap `florists.locale` on the test row),
submit with the hours grid and cutoff set, confirm the row updates, the
`lifecycle_stage` bump, the `florist_notes` entry, and that revisiting the same link
now shows the localized "already joined" state instead of the form.
