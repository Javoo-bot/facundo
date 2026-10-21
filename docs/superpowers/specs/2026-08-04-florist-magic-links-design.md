# Florist magic links + order deep links

**Status:** approved 2026-08-04

## Problem

Every florist-facing message we send already points at the right page. None of them
get the florist *to* that page.

An offer email's "View the order" button links to `/florist/orders/{assignmentId}`.
That path sits under `app/florist/(app)/`, whose layout does:

```ts
if (!user) redirect("/florist/login");        // layout.tsx:66
```

The order path is discarded. The florist then picks between Google OAuth, a typed
six-digit OTP, or a password — and lands on `/florist`, the home screen, hunting for
the order they were just looking at. On a phone, from an SMS, this is the worst
version of itself.

Many florists have no Supabase auth user at all: they were ingested, emailed an
offer, and never signed in. `florist_users` is auto-linked by email on first visit
(`layout.tsx:67-71`), so the very first sign-in is also an account creation.

## Goals

1. One click from any florist-facing message → signed in.
2. That click lands on the **specific order** the message is about, not the home screen.
3. When a link is too old to work, the florist still ends up on the right order after
   signing in normally.

## Non-goals

- Staff/backoffice links (`/cx`, `/orders/…`). Unchanged.
- Replacing the existing sign-in methods. Google/OTP/password all stay.
- Real invite emails, per the project non-goals.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| What a click grants | A **full florist session** — same as signing in | Matches how comparable florist/courier apps work. The alternatives (re-auth walls on money screens, or an order-scoped no-session token) either add a confusing mid-session wall or defeat the "link to the platform" ask. |
| Token lifetime | **30 days**, from mint | Mirrors `JOIN_TOKEN_TTL_DAYS` (`lib/floristJoin.ts`). Old emails go stale on their own. |
| Reuse | **Reusable** within the window | Single-use links are routinely burned by corporate link scanners (Outlook Safe Links) and Gmail's prefetcher *before* the human clicks, producing "link expired" on a perfectly valid email. Re-opening the same offer email must also keep working. |
| Granularity | **One token per send**, not per florist | An evergreen per-florist token means a two-year-old email still logs anyone in, and revoking it breaks every past email at once. Per-send is individually revocable. |
| Session clash | Staff **keep their staff session** | A staffer opening a real offer email must not be silently signed out of the backoffice and into a florist account. They get the existing read-only "view as florist" mode instead. |

### Accepted risks

Both follow directly from the full-session decision. Bounded, not removed.

1. **A forwarded message hands over the account** for up to 30 days — orders, payout
   history, bank details, team invites. Mitigated by the 30-day ceiling, per-send
   revocation, and a `use_count` that makes sharing visible after the fact.
2. **Login fixation, the reverse direction.** Someone sends a florist a link built from
   *their own* token; the florist clicks and is silently signed into the sender's
   account, so anything they then enter lands in the wrong shop's records. Staff are
   protected (their session is never swapped), florists are not. A "Continue as
   `<shop>`?" interstitial is the known fix — weighed during design and deferred,
   because it adds a click to the core flow for every florist to close an edge case.

Both are carried as `open` cross-cutting branches in `lib/lifecycle.ts`, so they stay
in the team's help-wanted roll-up rather than living only in this document.

## Data model

New table, service-role only (no RLS policies — same posture as other staff/system
tables; the dashboard reaches it through `lib/supabaseAdmin.ts`).

```sql
create table if not exists florist_magic_tokens (
  token         text primary key,
  florist_id    uuid not null references florists(id) on delete cascade,
  dest          text not null,
  purpose       text not null,
  assignment_id uuid references order_assignments(id) on delete set null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  use_count     integer not null default 0,
  revoked_at    timestamptz
);
```

`purpose` is one of `offer` / `issue` / `onboarding`.

**`dest` is stored on the row, not passed in the URL.** The emailed link is bare —
`/florist/m/{token}` — so there is no redirect parameter to tamper with, and a token
cannot be re-aimed at a different page. `dest` is always a relative path beginning
with a single `/`; the redeem route re-validates that before redirecting, so a bad
write can't become an open redirect either.

**One token serves one *offer*, not one *message*.** The offer email and the offer SMS
for the same send share a token, so a single order does not put two independent
credentials into the world.

## Components

### `lib/floristMagicLink.ts` — the pure half

Alias-free (relative imports only) so plain `node --test` can reach it, the same
convention `lib/floristJoin.ts` and `lib/offerEmailContent.ts` follow.

- `MAGIC_TOKEN_TTL_DAYS = 30`
- `TEST_MODE_MAGIC_TOKEN` — the inert sentinel (see *Test mode* below)
- `magicTokenExpiry(now: Date): string`
- `buildMagicUrl(base: string, token: string): string` → `${base}/florist/m/${token}`
- `isSafeDest(dest: string): boolean` — `startsWith("/") && !startsWith("//")`, the
  same guard `app/auth/callback/route.ts:12` already uses
- `magicTokenBlockReason(row, now): "not-found" | "revoked" | "expired" | "sentinel" | null`
  — the single authority on whether a token may be redeemed

### `lib/floristMagicLinkMint.ts` — the I/O half

`mintMagicLink(admin, { floristId, dest, purpose, assignmentId, now })` → absolute URL.
Split from the pure module so the pure one stays testable and alias-free.

### `app/florist/m/[token]/route.ts` — redeem

A Route Handler, not a page: only handlers can write cookies.

1. **Look up the token.** Blocked for any reason →
   `redirect("/florist/login?next={dest}&reason=link-expired")`. `dest` falls back to
   `/florist` when the token is unknown entirely. The florist still reaches the right
   order after signing in normally — this is what makes an expired link a detour
   rather than a dead end.
2. **Already this florist?** → straight to `dest`. No pointless re-auth.
3. **Staff session?** (`isAllowed(email)` and role ∈ `{ops, admin}`) → keep the staff
   session, mint the existing `fc_viewas` cookie (`lib/viewAs.ts::newClaim` /
   `encodeClaim`) for this florist, redirect to `dest` read-only. An allow-listed
   staffer *without* an impersonation-capable role gets the login bounce with an
   explanatory reason, never a silent sign-out.
4. **Otherwise** → sign in as the token's florist:
   - `admin.auth.admin.generateLink({ type: "magiclink", email })` → `properties.hashed_token`
   - `serverClient.auth.verifyOtp({ token_hash, type: "email" })` → session cookies set

   `generateLink` **creates the auth user** for `magiclink` if none exists, which is
   what makes this work for the majority of florists who have never signed in. The
   Supabase OTP it mints is consumed server-side within milliseconds, so its own
   ~1-hour expiry never reaches the florist; our 30-day row is the thing living in
   the inbox.
5. **Ensure the `florist_users` mapping row exists** — the auto-link logic currently
   inline at `layout.tsx:67-71`, extracted to `lib/floristLink.ts::ensureFloristUser`
   so it isn't written twice.
6. Bump `use_count` / `last_used_at`, redirect to `dest`.

Reusable-not-single-use is what makes step 4 survive link scanners: a scanner that
follows the URL gets a session cookie it immediately discards, and the florist's own
click still works.

The route lives at `/florist/m/…`, a florist path, so `lib/hostRouting.ts` already
passes it on the florist host and blocks it on the backoffice host. No routing change.

### Test mode

`lib/offerVars.ts:283-308` already establishes the rule for `unsubscribe_token`: a
test send must never carry a real florist's token, because staff share the test inbox
and a click would irreversibly act on a real shop. A magic token is strictly worse —
it is a *login*.

- **Test mode** → `TEST_MODE_MAGIC_TOKEN`, which `magicTokenBlockReason` rejects as
  `"sentinel"` before any DB lookup.
- **Preview** → the same sentinel and **no mint**. This preserves the "provable
  zero-write" property `offerVars.ts` documents at the top of the file. The mint sits
  behind a new `mintMagicToken` flag alongside the existing `mintUnsubscribeToken`.

## Call sites

| File | Change |
|---|---|
| `lib/offerVars.ts` | Mint once per send behind `opts.mintMagicToken`; expose `vars.orderUrl` |
| `lib/offerEmailContent.ts:235` | CTA + plain-text URL read `vars.orderUrl` instead of building `${APP_BASE}/florist/orders/${assignmentId}` |
| `lib/offerSmsContent.ts:35` | Takes `orderUrl` in `OfferSmsVars` — same token as the email |
| `lib/reachoutSend.ts` | Passes `mintMagicToken: true`; threads `r.vars.orderUrl` into the SMS |
| `app/api/orders/reachout/preview/route.ts` | Passes `mintMagicToken: false` |
| `lib/issueComms.ts:134,137` | Mints per florist-facing issue email |
| `app/api/florist/accept/route.ts` | On successful self-registration, mints and returns a magic URL |
| `components/florist/FloristAcceptForm.tsx` | Follows that URL, so onboarding ends *inside* the signed-in app rather than on a "thanks" card |

## The unglamorous half: `?next=`

Independent of magic links, and the reason an expired link degrades well:

- `app/florist/(app)/layout.tsx:66` → carry the requested path into `?next=`, read
  from the `x-pathname` header set by `middleware.ts` (Next does not expose the
  current path to a server layout otherwise).
- `app/florist/login/page.tsx` → honour `next` across **all three** sign-in methods.
  Today only `?invite=` survives. Validated with `isSafeDest`.
- `middleware.ts` → set `x-pathname` on passed-through requests. A one-line addition
  to the existing thin adapter; the routing decision itself stays in
  `lib/hostRouting.ts`.

## Testing

`node --test`, the existing lightweight convention (added to `package.json`'s `test`
script):

`lib/floristMagicLink.test.mjs`
- `magicTokenExpiry` is exactly 30 days out
- `buildMagicUrl` shape, and that it strips no slashes the base didn't have
- `magicTokenBlockReason`: fresh → `null`; past `expires_at` → `expired`; `revoked_at`
  set → `revoked`; the sentinel → `sentinel` **even when otherwise valid** (the
  test-inbox guard)
- `isSafeDest` rejects `//evil.com`, `https://evil.com`, `javascript:…`, and `""`

`lib/offerSmsContent.test.mjs` (extended)
- The SMS body carries the passed `orderUrl`, and no longer contains a bare
  `/florist/orders/` path

`lib/reachoutSend.test.mjs` (extended)
- Offer email CTA href is the magic URL
- No florist-facing message builds a bare `/florist/orders/…` URL any more

## Deployment prerequisites

Two steps outside the codebase, both required before this works in an environment:

1. **Run `supabase/migrations/2026-08-04-florist-magic-links.sql`** in the Supabase SQL
   editor (the project's standing convention for migrations). Until it exists, every
   magic link resolves to `not-found` and bounces to sign-in — the code degrades
   safely, it just doesn't do anything useful.
2. **Widen the Supabase Auth redirect allow-list** (Authentication → URL
   Configuration) to cover `/florist/**` on each host. Google sign-in now returns to
   whatever `next` held — `/florist/orders/<id>` rather than always `/florist` — and
   Supabase rejects a `redirectTo` that isn't allow-listed. The OTP and password
   paths are client-side `router.push` and are unaffected.

## Lifecycle map

Per `CLAUDE.md`, `dashboard/lib/lifecycle.ts` is updated in the same change:

- The offer-delivery stage's description gains the magic-link behaviour, and
  `lib/floristMagicLink.ts` + `app/florist/m/[token]/route.ts` join its `code` refs.
- A new branch on that stage: **florist clicks a stale magic link** — trigger (opened
  an email older than 30 days, or a revoked token), handling (bounce to login with
  `?next=` preserved so they still land on the order), status `handled`.
- A new `CROSS_CUTTING` entry: **a forwarded message grants account access** — the
  accepted risk above, status `open`, since we have settled a bound (30 days,
  revocable) but not a real mitigation.
