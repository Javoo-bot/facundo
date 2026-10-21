# Per-channel offer sends, test shops, and staff magic links

**Date:** 2026-08-05
**Status:** approved, ready for implementation

Three staff-facing gaps found while working order #2000018 (`xxxxxxxx`) with the
florist "Flors Demo" (`xxxxxxxx`):

1. An offer that is still **live** cannot be re-sent. `sendOffer(resend:true)`
   only reopens `declined`/`expired`/lapsed assignments, so a florist who says
   "I never got the mail" cannot be re-notified while their countdown runs.
2. Links in offer mail are inert placeholders, because `app_settings.test_mode`
   is on and test sends land in the shared staff inbox.
3. There is no way for staff to email a florist a sign-in link. Magic links
   exist, but only bundled into offer mail, issue mail, and the accept flow.

## Background: what already exists

Reading the current code first, because two of the three "bugs" are deliberate
designs and the third is half-built.

- **`lib/reachoutSend.ts::sendOffer`** is the one authoritative send path,
  shared by the manual reach-out route, the wave cron, and approval executors.
  Its defining property: the assignment is **claimed atomically (CAS) before any
  notification goes out**, so an overlapping cron tick or a double-click can
  never double-send. Exactly one caller wins; everyone else gets
  `not-sendable`. On email failure the claim is rolled back, CAS-guarded so a
  florist who accepted in the gap is never clobbered.
- **`lib/reachout.ts::resendBlockReason`** is the pure state-machine predicate
  behind the staff "Re-send offer" button. A live (`sent`/`opened`, unexpired)
  assignment returns `"still-live"` — deliberately blocked.
- **`lib/offerVars.ts::resolveOfferVars`** resolves every send-time variable
  once, and is called by both the sender and the preview route, so a staff
  preview can never drift from what actually goes out. In test mode it
  substitutes an inert sentinel for both the unsubscribe token and the magic
  link, because a test send lands in the SHARED staff test inbox and a magic
  link is **a login to a real shop**.
- **`lib/match.ts` and `ingest-worker/src/match.ts`** hold two copies of
  `passesHardFilter` / `matchFlorists`, kept in lockstep by convention.

None of this is being replaced. The design extends it.

## Ask 1 — Re-notify a live offer

### The distinction that drives the design

Re-delivering a live offer is **not** the same operation as reopening a dead
one, and the two must not share a code path.

`sendOffer(resend:true)` exists to *resurrect a dead assignment*: it nulls
`decline_reason`/`decline_detail`, claims via a two-statement CAS ladder, and
rolls back on failure. Re-delivering a live offer changes **no state at all** —
same `offer_expires_at`, same `sent_at`, no claim, and therefore nothing to roll
back.

Folding a live case into the CAS ladder would add a fourth way to mutate
assignment status purely to reuse code, and every future reader of that ladder
would have to work out which of four claims applies. Instead the two predicates
**partition the space**:

| assignment state | operation |
|---|---|
| `declined`, `expired`, lapsed `sent`/`opened` | `sendOffer(resend:true)` — reopen (unchanged) |
| live `sent`/`opened` (unexpired) | `renotifyOffer` — re-deliver (new) |
| `candidate`, `queued` | `sendOffer` — first send (unchanged) |

### `lib/reachout.ts` — new pure predicate

```
renotifyBlockReason(a, orderStatus, orderDeletedAt, lastSentAtByChannel, channel, nowMs)
  → RenotifyBlockReason | null
```

Returns `null` only when: the order is resendable (same
`ORDER_RESENDABLE_STATUSES` / not deleted / not cancelled rules
`resendBlockReason` already applies), the assignment is `sent` or `opened` and
**not** lapsed — precisely the `"still-live"` case resend rejects — and the
per-channel cooldown has elapsed.

Reasons: `order-deleted`, `order-cancelled`, `order-not-open`, `not-live`,
`cooling-down`.

Pure and alias-free (relative imports only), like its neighbors in this file, so
`node --test` can exercise it directly.

### `lib/reachoutRenotify.ts` — the operation

```
renotifyOffer(assignmentId, actor, { channels, resetWindow }) → RenotifyResult
```

- Resolves send-time variables through the **same** `resolveOfferVars` the
  sender and preview use, so a re-notify can never drift from a send.
- **Sibling-accept guard.** Re-reads order status and assignment status
  immediately before any leg fires, and aborts if the order is no longer
  resendable or the assignment is no longer live. Without a claim this is the
  only thing standing between CX and emailing an offer for an order another
  florist just accepted. The residual single-round-trip window is the same one
  every CAS in `reachoutSend.ts` already accepts.
- **No claim, no status write, no rollback.** `resetWindow` is the *only* write:
  one CAS'd `offer_expires_at` update guarded on the row still being
  `sent`/`opened`, using the same expiry computation `resolveOfferVars` produces.
- Emits an `outreach_renotified` order event carrying the channels attempted,
  their per-channel outcome, and `reset_window`.

### Cooldown

Two minutes, **per assignment per channel**, derived from the last
`communications` row for that assignment (kinds `offer` / `offer_renotify`,
status `sent`). No new column — `communications` already records every send with
a timestamp.

Per-channel rather than global so re-sending an email does not lock out a push.

### Per-channel sends

Both `sendOffer` and `renotifyOffer` take
`channels?: ("email" | "sms" | "push")[]`, intersected with the existing
settings-level gates (`email_offer_enabled`, `sms_offer_enabled`).

This is an extension of established behavior, not a new concept: push-only sends
already happen today when email is disabled by settings, so "some legs fire,
some don't" is already the norm. Per-channel suppression stays honored —
offer-unsubscribe gates email, SMS opt-out gates SMS.

**The claim in `sendOffer` is untouched.** Channel selection is applied *after*
the CAS, so double-send protection is unchanged.

Both operations return a **per-channel result** (`sent` / `skipped` + reason /
`failed`), so the UI can say "email sent, SMS skipped — no phone on file"
instead of one opaque success.

### Surfaces

- `POST /api/orders/reachout` gains action `"renotify"` with
  `{ channels?, resetWindow? }`, ops/admin gated like its siblings.
- `components/orders/ReachoutPanel.tsx`: a live assignment gets a "Re-send"
  control with three channel checkboxes (all on by default) and a "give them a
  fresh window" checkbox (off by default). The first-send control gets the same
  three checkboxes. Blocked states render the reason, reusing the existing
  blocked-with-reason pattern in that file.

## Ask 2 — Test shops

### Schema

```sql
alter table florists add column is_test_shop boolean not null default false;
alter table app_settings add column test_shop_matching text not null default 'exclude'
  check (test_shop_matching in ('exclude', 'only'));
```

The per-shop flag says *what a shop is*; the global mode says *how matching
treats them*.

### Messaging behavior

In `lib/offerVars.ts`, every test-mode branch changes from `testMode` to
`testMode && !isTestShop`: recipient address, magic token, unsubscribe token,
SMS number.

A flagged shop receives real mail at its real address with working links. **Every
unflagged florist keeps exactly today's behavior** — this is the safety property
that matters, and it is why the flag lives on the florist row rather than on a
per-send checkbox that a mis-click could defeat.

Logs still record `test_mode: true` (it *is* a test-mode send) and additionally
`test_shop: true`, so the audit trail explains why real credentials went out.

### Matching behavior

`passesHardFilter(o, f, mode)` gains a third argument in **both** matcher copies
(`dashboard/lib/match.ts`, `ingest-worker/src/match.ts` — these are kept in
lockstep):

- `exclude` (default): drop `is_test_shop` florists. A paying customer's order
  can never be routed to a test shop.
- `only`: drop non-test shops. Automatic matching routes exclusively to test
  shops, so the whole loop can be exercised end to end with real mail.

The queries feeding the matcher (`app/api/orders/rematch/route.ts`, the worker's
match step) add `is_test_shop` to their column lists.

**`only` is a foot-gun if left on**: orders outside a test shop's radius match
nothing and escalate to CX. It gets a persistent banner in the app while active.

### Surfaces

- Admin-only toggle on `/florists/[id]` with a plain-language warning.
- A badge wherever a florist is listed, so a test shop is never mistaken for a
  real partner.
- `test_shop_matching` selector in Settings, plus the active-mode banner.

## Ask 3 — Staff magic-link email

```
lib/floristMagicEmail.ts::sendFloristMagicLink(floristId, dest, actor) → result
```

- Mints through the existing `lib/floristMagicLinkMint.ts::mintMagicLink` with a
  new `purpose: "staff_link"`; `isSafeDest` already rejects anything that is not
  a local path.
- Sends a short localized mail through the existing email chrome, logs a
  `magic_link` communication (`kind` is free text on that table — no migration).
- Honors the Ask-2 redirect rule, so in test mode an unflagged florist still
  gets the inert sentinel.
- **Deliberately ignores offer-unsubscribe suppression.** A sign-in link is
  account access, not an offer. It still skips a florist with no email.
- Two-minute per-florist cooldown, same derivation as Ask 1.

Two entry points, one action, via `POST /api/florists/magic-link` (ops/admin):

- `/florists/[id]` → "Email sign-in link", dest `/florist`
- order page, per assignment → "Email link to this order", dest
  `orderDest(assignmentId)`

## Testing

Following the repo's lightweight `node --test` convention (per `CLAUDE.md`, the
existing guard tests are the precedent):

- `lib/reachout.test.mjs` — table tests for `renotifyBlockReason` across every
  assignment status, lapsed vs live, each order status, and the cooldown
  boundary. Also assert it is the exact **complement** of `resendBlockReason`
  for `sent`/`opened`: no state may be accepted by both, and no live state
  rejected by both.
- `lib/match.test.mjs` — `passesHardFilter` under both modes, asserted against
  **both** matcher copies so they cannot drift.
- Channel-intersection logic (requested channels ∩ settings-enabled channels)
  as a pure table test.

## Verification

Per `CLAUDE.md`: no phase is claimed working without being run.

- `tsc --noEmit`, ESLint, `next build`, and the `node --test` suite.
- End-to-end against Flors Demo with `is_test_shop` on: real mail at
  `staff+florist@fc.example.com`, a working magic link, landing on the order.
  This is the entire point of Ask 2, so it is the acceptance test.
- Both matching modes exercised against a real order.

## Order-lifecycle map

`CLAUDE.md` requires `dashboard/lib/lifecycle.ts` to be updated in the same
change as any order-loop work:

- `reachout-resend` branch: note that re-notify now covers the live case the
  resend rule deliberately blocks.
- New branch on the `reachout` stage for "florist never received the offer".
- New cross-cutting entry for test shops and the two matching modes.

## Open question found while reading

`lib/lifecycle.ts`'s `match-unready-florist` branch claims the hard filter
rejects florists missing `delivery_radius_km` or `trust_tier`, but the
`passesHardFilter` in `dashboard/lib/match.ts` checks neither. The two matcher
copies differ in length (126 vs 138 lines), so they may already have drifted.
This will be confirmed during implementation and reported — **not** silently
"fixed", since which copy is correct is a product decision.

## Explicitly out of scope

- A free-text "message this florist" composer.
- Manual triggers for every automated message in the loop (client assigned /
  on-the-way / delivered, CX alerts, issue mail). If wanted, its own spec.
- Any change to the `sendOffer` claim ladder or the wave engine.
