# Late accept + configurable offer window — design

**Date:** 2026-08-03
**Status:** approved, ready to plan

## Problem

Two related gaps in the reach-out loop, both found while investigating order
`#2000014`:

1. **A lapsed offer is dead even when the order is still unclaimed.** The florist
   accept path (`dashboard/app/api/florist/respond/route.ts`) never reads
   `offer_expires_at`. Expiry bites only because `advanceWaves()` flips
   `sent`/`opened` → `expired`, and `expired` isn't in the allowed status list.
   So a florist who replies twenty minutes late is refused, even when nobody else
   accepted, the delivery is a day out, and the order is sitting in the CX
   escalation queue precisely because nobody took it. Meanwhile an explicit
   `declined` **is** re-acceptable ("changed my mind") — the weaker signal is
   treated more permissively than the stronger one.

2. **The offer window is hardcoded.** `suggestedTimeoutMinutes` in
   `dashboard/lib/reachout.ts:24` is a fixed urgency ladder (15/30/60/120 min,
   60 with no delivery date). Widening it for a peak weekend needs a deploy.

## Decisions

Settled during brainstorming:

| Question | Decision |
|---|---|
| What does "withdrawn" mean? | An explicit staff **Withdraw** action, stamping the `withdrawn_at` column that already exists in the live DB but in no repo migration. |
| What is "too late" measured against? | `delivery_at` minus a **configurable buffer** (default 2h, matching the existing `sla_deadline_at` convention). Null `delivery_at` = no cutoff. |
| What shape is the configurable window? | The **four urgency tiers stay**, each editable in Settings, defaults = today's values. |
| Can a late accept rescue an escalated order? | **Yes**, and it clears the escalation. That is the case the feature exists for. |

## Consequence to keep in mind

`expired` stops meaning "closed" and starts meaning "the response window lapsed".
The status is no longer the authority on whether an accept is allowed — the
predicate below is. This mirrors the move already made for `declined`, so it is
consistent with the codebase rather than novel, but every read of
`status === "expired"` as "done" needs checking. The two that matter are the
florist detail view and the staff reach-out panel; both are in scope.

## Architecture

### 1. Data model

One migration, `supabase/migrations/2026-08-03-late-accept-and-offer-window.sql`:

```sql
alter table app_settings add column if not exists offer_window_rush_min      integer not null default 15;   -- delivery <= 6h
alter table app_settings add column if not exists offer_window_sameday_min   integer not null default 30;   -- <= 24h
alter table app_settings add column if not exists offer_window_standard_min  integer not null default 60;   -- <= 72h
alter table app_settings add column if not exists offer_window_far_min       integer not null default 120;  -- beyond
alter table app_settings add column if not exists offer_window_nodate_min    integer not null default 60;   -- no delivery_at
alter table app_settings add column if not exists late_accept_buffer_hours   integer not null default 2;
alter table order_assignments add column if not exists withdrawn_at timestamptz;
```

Defaults reproduce today's behaviour exactly, so the migration alone is a no-op.

**No new assignment status.** Withdraw stamps `withdrawn_at` and, when the offer
is still open (`candidate/queued/sent/opened`), moves status to `expired`. The
`check (status in (...))` constraint, the `AssignmentStatus` union, and every
switch over status are untouched. `withdrawn_at` is the authority for "we took
this off the table", and pairs with the existing `declined_at` / `accepted_at`.

The `withdrawn_at` line also reconciles the repo with production, where the
column already exists but was never captured in a migration.

### 2. The predicate — `dashboard/lib/lateAccept.ts` (new)

Pure, no I/O, unit-testable — the same shape as
`lib/reachout.ts::resendBlockReason`, which exists for the same reason: the
florist PWA decides whether to render Accept, and the API decides whether to
honour it, and those two must never disagree.

```ts
export type AcceptBlockReason =
  | "order-deleted"     // order soft-deleted
  | "withdrawn"         // staff pulled this offer
  | "assignment-closed" // accepted/reassigned/released/delivered — terminal for this florist
  | "order-closed"      // someone else holds it, or it's past accepting (incl. `received`)
  | "too-late";         // within the buffer before delivery

export function acceptBlockReason(
  assignment: { status: string; withdrawn_at: string | null },
  order: { status: string; delivery_at: string | null; deleted_at: string | null },
  bufferHours: number,
  nowMs: number
): AcceptBlockReason | null;
```

Rules, in order (first match wins):

1. `order.deleted_at` → `order-deleted`
2. `assignment.withdrawn_at` → `withdrawn`
3. `assignment.status` not in `candidate|queued|sent|opened|declined|expired` → `assignment-closed`
4. `order.status` not in `matched|reaching_out|escalated` → `order-closed`
5. `delivery_at != null` and `now > delivery_at − bufferHours` → `too-late`
6. otherwise `null` — acceptable

Note rule 4 keeps `received` excluded. That is deliberate and pre-existing: in
semi mode an order rests at `received` with candidates written while CX reviews
the match approval, and a candidate must not be able to self-accept past that
gate.

The predicate governs **accept only**. Decline keeps its current precondition
(status in `candidate|queued|sent|opened`) — there is nothing to gain from
declining a lapsed offer, and widening it would let a florist decline an offer
the wave engine has already moved past.

### 3. The offer window — `dashboard/lib/reachout.ts`

`suggestedTimeoutMinutes(deliveryAt, windows?)` gains an optional second
argument; `DEFAULT_OFFER_WINDOWS` holds today's values, so every existing call
site keeps working unchanged. `lib/offerVars.ts` already reads `app_settings`
for the send — it selects the five window columns in that same query and passes
them through. One extra column read, no extra round trip.

### 4. Server paths

**`app/api/florist/respond/route.ts`** — replace the ad-hoc `allowedForAction`
list with `acceptBlockReason`, map each reason to its 409, and widen the order
CAS from `["reaching_out","matched"]` to include `"escalated"`. The CAS stays
the sole authority; the predicate is a pre-check that produces an honest error
message. On a successful accept from `escalated`, write a `late_accept`
`order_event` so CX can see why the order left their queue.

**`app/api/orders/reachout/route.ts`** — new `action: "withdraw"` alongside
send/accept/decline/escalate/resend. Stamps `withdrawn_at`, CAS-guarded moves an
open offer to `expired`, writes an `offer_withdrawn` order_event. `ops`/`admin`,
same gate as the other actions.

**`app/api/settings/route.ts`** — validate the six new fields as integers in
range (windows 1–1440 minutes, buffer 0–72 hours), falling back to the defaults
when omitted, in the style of the existing `default_payout_percent` check.

### 5. UI

- **`components/florist/FloristOrderDetail.tsx`** — the Accept button is
  currently gated on `assignment.status`; gate it on `acceptBlockReason` instead
  so a lapsed-but-acceptable offer still shows it. When the reason is non-null,
  show the corresponding message rather than a bare "no longer available".
- **`components/florist/OfferCountdown.tsx`** — at zero, instead of a flat
  "expired" badge, say the window lapsed but the offer can still be accepted
  (when it can).
- **`components/orders/ReachoutPanel.tsx`** — a **Withdraw** control on each
  live/lapsed candidate row, and a "withdrawn" state on rows that have it.
- **`components/SettingsClient.tsx`** — a new "Offers" block with the five
  window fields and the buffer, following the `default_payout_percent` numeric
  input pattern.

### 6. Tests

`node --test`, the existing lightweight convention, registered in
`dashboard/package.json`:

- `lib/lateAccept.test.mjs` — table-driven over the six rules: withdrawn blocks;
  expired + open order + far delivery passes; inside the buffer fails; escalated
  passes; `received` blocks; accepted-by-another blocks; null `delivery_at`
  never triggers `too-late`.
- extend `lib/reachout.test.mjs` — `suggestedTimeoutMinutes` honours custom
  tiers and falls back to the defaults when omitted.

### 7. Lifecycle map

`dashboard/lib/lifecycle.ts` — update the `reachout-timeout` branch (expiry is
no longer terminal) and add a branch for the late accept and for the staff
withdraw, per the repo rule that order-loop work updates the map in the same
change.

## Out of scope

- No change to the wave engine. It keeps expiring lapsed offers, because that is
  what promotes the next candidate; `expired` simply stops being a closed door.
- No new locking. A late accept racing a freshly-promoted florist is resolved by
  the existing order-level CAS — first writer wins, the loser gets "This order
  was just taken."
- No notification to the florist when an offer is withdrawn.
