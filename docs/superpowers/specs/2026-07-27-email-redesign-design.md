# Florist Email Redesign — Logo, Unsubscribe, Footer Content, Short Variant

## Context

`dashboard/lib/emailTemplate.ts` renders one shared HTML shell used by every
outbound email (offer, client assigned/on-the-way/delivered, issue
notifications, CX alerts). The florist-facing side was localized to
EN/FR/ES/IT/DE in the previous branch (see
`2026-07-26-florist-frontend-i18n-design.md`). This pass upgrades the visual
and compliance surface of those emails, driven by two sources: the user's
explicit ask (logo, unsubscribe, "nicer design") and
`Local Florist Network — Flow & Screens.pdf` (Angy's original UX spec for the
order-offer flow, referred to below as "the artifact"), which the user
pointed to for "the info Angy wanted."

The artifact documents the **full order flow** (offer email → accept/decline
pages → payment emails → portal), most of which is already built. Only the
pieces below are new work; everything else in the artifact describes
already-shipped behavior and is out of scope.

## Scope

**In scope** (florist-facing emails only — customer emails stay untouched,
per the existing English-only decision):
1. Real wordmark logo in the shared email header (all templates, via the shell).
2. Unsubscribe for the **offer** email specifically — pause 30 days, or stop
   permanently — plus a `List-Unsubscribe` header.
3. Configurable florist support contact in the offer email footer.
4. Offer-email content parity with the artifact: a short variant for
   florists who've recently completed an order through this flow, and a
   "How it works" explainer page for that variant's footer link.

**Out of scope** (explicitly, from the artifact but not built here):
- The artifact's "NEW" florist tier (unregistered, request business/tax
  details) — this app has no self-registration flow for existing florists;
  they're already ingested and matched. There is nothing to collapse this
  into except the existing full-email path (see Task section below).
- Any change to `florists.source` (existing/known/new) — that field is an
  unrelated, staff-set matching-weight concept (`lib/match.ts`), not a
  recency-of-engagement signal. Do not confuse the two or touch that column.
- Customer-facing (`clientComms.ts`) and CX-facing email content/unsubscribe.
- Any change to the accept/decline pages, payment flow, or portal — all
  already built and working.

## 1. Logo

**Problem:** the shell header shows a 32×32 crown-mark PNG + plain text
"Facundo" — never the actual wordmark (`FacundoLogo.tsx`) used at
florist login / backoffice sign-in / both shell headers.

**Constraint (from the artifact, "FOR DEVELOPMENT" note on the offer email
screen):** *"Email layout must use `<table>`, not flexbox — Outlook and
others ignore it. Icons as hosted PNG: SVG does not render in Gmail."* This
rules out inlining `public/brand/facundo-logo.svg` or the React component
directly — it must be a hosted raster image, exactly like the existing
crown-mark already is.

**Approach:**
- One-time asset generation: rasterize `public/brand/facundo-logo.svg`
  with `sharp` (already present transitively via `next`, confirmed working
  in this session — no new dependency) to a 2x PNG and commit it as
  `public/brand/facundo-logo-email.png`. Target a displayed height around
  32px (so a physical PNG height of ~64px, width auto per the ~3.77:1
  viewBox aspect ratio — confirmed empirically: 128px height in → 482×128px
  out).
- In `emailTemplate.ts`'s header table cell, replace the `MARK_URL` `<img>` +
  `<span>Facundo</span>` combo with a single `<img>` pointing at this new
  PNG, explicit `width`/`height` attributes (required for email client
  layout stability), `alt="Facundo"`.
- Keep the header's existing light background (`HEADER_BG`) and green top
  border — the wordmark's own colors (black-ish ink letterforms + coral
  crown, baked into the static SVG export) read fine against it; no shell
  background change needed.
- This is a shell-level change — it cascades to every email (offer, client,
  issue, CX alert) with no per-template edits.

## 2. Unsubscribe

**Problem:** no unsubscribe mechanism exists anywhere — no DB column, no
token, no landing page, no `List-Unsubscribe` header. The artifact is
explicit about why this matters (deliverability, not just courtesy): *"Without
an opt-out, a florist who has stopped reading marks us as spam instead — and
that quietly damages deliverability for every other florist on the same
sending domain."* It also explicitly recommends offering both a temporary
pause and a permanent stop, since "not for now" and "not ever" are different
florist intents and conflating them loses shops that might come back.

**Scope decision:** unsubscribe applies to the **offer** email only. It's
the one recurring, solicitation-style email or an already-accepted order —
a florist can't sensibly "unsubscribe" from being told their own order is
paid or has an issue.

**Data model** (new migration
`supabase/migrations/2026-07-27-florist-email-unsubscribe.sql`):
```sql
alter table florists
  add column if not exists order_emails_snoozed_until timestamptz,
  add column if not exists order_emails_opt_out boolean not null default false,
  add column if not exists unsubscribe_token text unique;
```
- `order_emails_snoozed_until`: null = not snoozed; a future timestamp =
  snoozed until then (auto-resumes once past — no cron needed, just compare
  against `now()` at send time).
- `order_emails_opt_out`: permanent stop. Once true, only a florist
  explicitly re-opting in (not built — no path back in this pass, matching
  "no admin UI beyond the dashboard" — staff can flip it via direct DB
  access same as other operational-only fields) would change it.
- `unsubscribe_token`: opaque, unguessable, generated lazily (see below) —
  not a JWT/HMAC, just a stored random token, consistent with this
  project's preference for simple stored state over derived crypto for
  POC-scale needs.

**Token generation:** `sendOffer` (in `reachoutSend.ts`) ensures the florist
has a token before building the email — if `florist.unsubscribe_token` is
null, generate one (`crypto.randomUUID()` is sufficient — 122 bits, already
used elsewhere in this codebase's uuid columns) and persist it in the same
`update` as other assignment/claim writes, then use it in the email.

**Send-time gate:** `sendOffer` checks `order_emails_opt_out` and
`order_emails_snoozed_until` (compared to `now()`) right alongside its
existing `no-test-email`/`florist-no-email` checks, using the same
skip-and-log pattern (a `logCommunication` call with
`status: "skipped", error: "unsubscribed"` or `"snoozed"`, no `outreach` row
— mirrors the existing `disabled-by-settings` branch). The push notification
still fires (unsubscribe only gates the email leg, exactly like the
existing per-type toggles) — being unreachable by email doesn't mean they
shouldn't hear about a matching order some other way.

**Public unsubscribe page:** `app/florist/unsubscribe/[token]/page.tsx` — no
login required (florists clicking this link may not have signed in). On
load, look up the florist by `unsubscribe_token` via the service-role
client (RLS is staff-only on this table, same reason the rest of the
florist-self-service surface uses `createServiceClient()`). If the token
doesn't resolve to a florist, render a generic "this link isn't valid
anymore" state rather than an error — no information disclosure, no crash.
Renders two buttons:
- "Pause for 30 days" → `POST /api/florist/unsubscribe` with
  `{ token, action: "snooze" }`.
- "Stop completely" → same route, `{ token, action: "stop" }`.

**API route:** `app/api/florist/unsubscribe/route.ts` — `POST` only, takes
`{ token: string, action: "snooze" | "stop" }`. Looks up the florist by
token (service-role), 404s (as a generic "invalid link" JSON, not a stack
trace) if not found. `action: "snooze"` sets
`order_emails_snoozed_until = now() + 30 days`; `action: "stop"` sets
`order_emails_opt_out = true`. No auth beyond token possession — this is the
standard unsubscribe-link security model (same as every other end).

**Email content:** the offer email's `renderParagraphs` block after the
reply-window note gets one small line with a single link — one URL, not
two, since the landing page itself presents both the pause and stop choices
(no need for two near-identical links in the email that both land on the
same decision point). New catalog key `email.offer.unsubscribe`, e.g.
`"Getting too many of these? Manage your order emails →"`, linking to
`${APP_BASE}/florist/unsubscribe/{token}`.

**Compliance header:** `lib/email.ts`'s `sendEmail` gains an optional
`headers?: Record<string, string>` field, passed through to the Resend
request body's own `headers` key
(Resend supports arbitrary custom headers — this is additive, no existing
call site is affected since the field is optional). `sendOffer` passes:
```ts
headers: {
  "List-Unsubscribe": `<mailto:${supportEmail}>, <${unsubscribeUrl}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
}
```
This is a real deliverability improvement the artifact doesn't mention but
falls out naturally of building the link — inbox providers use this header
to offer a one-click unsubscribe in their own UI, which reduces
spam-button clicks (the actual deliverability risk Angy's note is about).

## 3. Configurable support contact

**Problem:** the artifact's footer shows `florists@fc.example.com`; no such
address is wired up anywhere in this codebase (only an unrelated `cx_email`
— the ops/CX inbox for issue escalations — and a placeholder string in a
settings input).

**Approach** (mirrors the existing `cx_email` pattern exactly):
- Migration adds `app_settings.florist_support_email text` (nullable —
  `sendOffer` falls back to the literal `florists@fc.example.com` default
  when null, so this never blocks a send).
- `app/api/settings/route.ts`: accept `florist_support_email` in the POST
  body, validate as a valid email or null (same `EMAIL_RE` already defined
  in that file), persist it.
- `components/SettingsClient.tsx`: new field next to the existing "CX / ops
  inbox" input, labeled "Florist support email" with helper text "Shown to
  florists in the order-offer email footer."
- `sendOffer` reads `florist_support_email` off the same `app_settings`
  select it already does (add the column to the existing `.select(...)`
  call), falls back to the default, and renders it as a `mailto:` link in
  the offer email footer alongside the unsubscribe line.

## 4. Offer-email content parity: short variant + "How it works" page

**What the artifact specifies:** three tiers (new/known/active) choosing
between a "full" email (headline, 20-word payment-first intro, 5-step "how
it works", facts block, reply-window note) and a "short" email (one-line
greeting, facts block, reply-window note only — no intro, no steps) —
active florists (an order through this flow in the last 2 months) get
short; everyone else gets full. The short version keeps a small "How it
works" footer link since it drops the inline steps.

**Adapting to what's actually built:** this app has no self-registration
gate (the artifact's "new" tier, which asks for tax/business details before
paying), so there is no third state to build — every florist here is
already "in the network." The tri-state collapses to a **two-state** check:
has this florist accepted at least one order through this flow in the last
2 months ("active" → short) or not ("full", the current, unchanged
behavior — this covers both the artifact's "new" and "known" cases, which
already render identically in this app).

**State derivation** (new local helper in `reachoutSend.ts`, queried once
per `sendOffer` call, right after the existing florist fetch):
```ts
async function hasRecentAcceptedOrder(admin: ReturnType<typeof createServiceClient>, floristId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - 60 * 24 * 3600_000).toISOString(); // ~2 months
  const { data } = await admin
    .from("order_assignments")
    .select("id")
    .eq("florist_id", floristId)
    .not("accepted_at", "is", null)
    .gte("accepted_at", cutoff)
    .limit(1)
    .maybeSingle();
  return !!data;
}
```
`accepted_at` (not `delivered_at`) is the signal — a florist who's accepted
at least once recently already knows how the flow works, which is the
actual thing "active" is a proxy for; waiting for full delivery completion
would under-count florists who are actively mid-order.

**Two content builders in `reachoutSend.ts`:**
- `buildOfferEmailContent` (existing, renamed internally to the "full"
  path) — unchanged output for florists who are not "active".
- `buildOfferEmailContentShort` — new function, same `OfferEmailVars` shape
  plus a required `floristName: string` (already fetched in `sendOffer`,
  just not currently threaded into `OfferEmailVars` — add it). Renders:
  `renderParagraphs(tt("email.offer.short.greeting", { floristName }))` (one
  line: *"Hi {floristName} — we have another delivery for you."*) +
  `renderFactsBlock(facts)` (same facts array as the full version) +
  `renderParagraphs(tt("email.offer.replyWindowNote", { window: replyWindow }))`
  + a `renderParagraphs` line linking to the how-it-works page:
  `tt("email.offer.short.howItWorks")` rendered as an anchor tag (small,
  muted, matching the footer link styling already used for the unsubscribe
  line — this one line needs its own tiny helper since `renderParagraphs`
  escapes and doesn't support embedded `<a>`; add a one-off
  `renderLinkLine(text, url)` alongside `renderFactsBlock` in
  `emailTemplate.ts`, following the same "plain string templating" style).
- `sendOffer` picks the builder based on `hasRecentAcceptedOrder(...)`,
  same subject-line logic and CTA for both (the artifact's subject-wording
  difference between variants is stylistic, not a stated requirement — the
  existing subject already satisfies the three required elements: city,
  order number, hook).

**"How it works" page** (`app/florist/how-it-works/page.tsx`, public, no
auth — reached from an email, possibly before the florist has ever signed
in): a plain Server Component reading `?locale=` from `searchParams`
(validated via `isLocale()`, falling back to `DEFAULT_LOCALE` — this page
can't call `currentFloristLocale()`, there's no session), rendering the
same 5 steps already in the catalog (`email.offer.step1-5Title/Body`,
reused as-is — no new catalog entries needed for the steps themselves,
just the page chrome: heading + back-conceptually-to-inbox copy) under new
`ui.howItWorks.*` keys. The offer email's short-variant link includes
`?locale={locale}` so the page opens in the florist's own language.

## Data Flow Summary

```
sendOffer()
  ├─ fetch florist (email, name, locale, unsubscribe_token, order_emails_opt_out, order_emails_snoozed_until)
  ├─ if opt_out or snoozed_until > now(): skip email leg, log "skipped", push still fires
  ├─ else:
  │   ├─ ensure unsubscribe_token exists (generate + persist if null)
  │   ├─ hasRecentAcceptedOrder(florist_id) → variant: "short" | "full"
  │   ├─ build content via the matching builder
  │   ├─ sendEmail({ ..., headers: { List-Unsubscribe, List-Unsubscribe-Post } })
  │   └─ outreach row, as today
```

## Error Handling

- Missing/invalid `?locale=` on the how-it-works page → `DEFAULT_LOCALE`,
  never a 400 (it's a florist-facing link from an email; must never dead-end).
- Unknown/garbage unsubscribe token → generic "this link isn't valid
  anymore" page state, not a 404 crash or stack trace (avoids confirming
  whether a token ever existed).
- `florist_support_email` null → falls back to the hardcoded default, never
  renders an empty `mailto:` link.
- All new DB columns are nullable-or-defaulted additive migrations — no
  backfill required, no existing behavior changes until a florist actually
  hits unsubscribe or accepts a recent order.

## Testing

- `emailTemplate.test.mjs`: extend for the new `renderLinkLine` helper and
  the new logo `<img>` (asserts the PNG URL, explicit width/height attrs,
  no `<svg>` in the output anywhere in the shell).
- `reachoutSend` currently has no dedicated unit test file — add
  `lib/reachoutSend.test.mjs` covering: `hasRecentAcceptedOrder`'s pure date
  math (extract the cutoff calculation to a testable pure function, same
  pattern as `formatReplyWindow`/`isSameDay` in the same file), and that
  `buildOfferEmailContent` vs `buildOfferEmailContentShort` produce the
  expected structural differences (short has no `howItWorksTitle` string in
  its output, full does).
- `i18n.test.mjs`: the existing key-parity test (every EN leaf present in
  all locales) automatically covers every new catalog key added here — no
  new test needed there, just populate all five locale files per key.
- Manual verification: same disclosed limitation as the previous branch —
  no live florist test credentials in this environment. Verify via
  `node --test`, `tsc`, `next build`, and careful reading; flag manual
  browser/email-client verification (especially Gmail rendering of the new
  logo `<img>` and the unsubscribe links) as a recommended pre-merge step.

## Non-Goals (restated)

- No re-opt-in flow (staff-only DB fix, matching the project's "no admin UI
  beyond the dashboard" convention).
- No change to `florists.source`, the accept/decline pages, payment emails,
  or the portal.
- No customer-facing (`clientComms.ts`) unsubscribe or content changes.
- No professional/native-speaker translation QA pass (same disclosed
  limitation as the prior i18n branch).
