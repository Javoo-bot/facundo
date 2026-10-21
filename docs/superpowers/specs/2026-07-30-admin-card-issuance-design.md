# Admin-Initiated Card Issuance — Design

**Goal:** give staff a manual escape hatch on the Airwallex money path, closing a gap the
lifecycle map already documents as unhandled. Two distinct capabilities:

- **Retry** — manually re-attempt a specific order's `failed` payout leg (today only the
  outbox drainer retries these; a human has no button).
- **Ad-hoc issue** — an admin issues a single-use card to a florist that isn't tied to any
  order (goodwill payment, correction, one-off).

Plus a smaller addition: an "active cards" view on the existing Payments ledger.

## Scope

- **Part A — Manual retry.** Expose the existing `retryPayoutRow` as a staff-triggered action
  on the order page, for `failed` legs. finance+admin gated (same as every other payout action
  on that page).
- **Part B — Ad-hoc issuance.** New `issueManualPayout` in `lib/payout.ts`, a new `leg='manual'`
  payout row not tied to an `order_assignment`, admin-only. Same guards as every other payout
  (kill switch, exposure cap, live-funds check).
- **Part C — Active cards view.** A filter on `/payments` (not a new page): active = a real,
  spendable card exists. Canceling stays on `/payments/[id]` (existing `StaffCardActions`) —
  no inline table action.
- **Non-goals:** non-EUR ad-hoc payouts, an inline cancel-from-table action, a florist-facing
  surface for any of this (staff-only), changing how automatic order payouts are gated.

## Data model — migration `2026-07-30-admin-card-issuance.sql`

```sql
alter table payouts alter column assignment_id drop not null;
alter table payouts add column florist_id uuid references florists(id);

alter table payouts drop constraint payouts_leg_check;
alter table payouts add constraint payouts_leg_check
  check (leg in ('accept', 'delivery', 'manual'));

alter table payouts add constraint payouts_leg_shape_check
  check (
    (leg = 'manual' and assignment_id is null and florist_id is not null)
    or
    (leg in ('accept', 'delivery') and assignment_id is not null and florist_id is null)
  );
```

`florist_id` is populated **only** for manual legs. Order legs keep deriving florist via the
existing `assignment_id → order_assignments → florists` join — no backfill, no change to
existing rows or existing queries' shape.

`payouts_assignment_leg_uidx` (unique on `(assignment_id, leg) where status <> 'clawed_back'`)
is untouched — Postgres treats each `NULL` `assignment_id` as distinct, so multiple manual rows
coexist without a uniqueness conflict.

`finalize_payout(...)`: `p_order_id` becomes nullable; the `order_events` insert is guarded
with `if p_order_id is not null`. Existing callers (order-driven legs) always pass a real
`order_id`, so their behavior is unchanged. Manual payouts pass `null` and simply skip the
order-timeline write (there is no order to attach it to) — the `payment_events` row (which
carries `payout_id`, not `order_id`) still records the issue/fail either way.

## `lib/payout.ts` changes

- `issueAndFinalize`: `assignmentId`/`orderId` widen to `string | null`. The rail idempotency
  ref becomes `` `${assignmentId}:${leg}` `` when `assignmentId` is set, else `` `manual:${payoutId}` ``
  (the payout row already exists by this point, so its id is a stable, unique ref).
- New `issueManualPayout({ floristId, amount, reason, actor }): Promise<PayoutOutcome>`:
  1. Look up the florist's `trust_tier`; no tier → `reason: "no-tier"` (same rule as order
     payouts — keeps exposure-cap semantics meaningful for every florist this rail touches).
  2. `guardExposureAndFunds` (paused kill switch, exposure cap, live-funds check) — same
     function order payouts use, not a parallel copy.
  3. Insert the `payouts` row (`leg:'manual'`, `assignment_id:null`, `florist_id`, `status:'pending'`).
  4. `issueAndFinalize` with `assignmentId: null`, `orderId: null`.
  5. Record `reason` in the `payment_events` payload (same convention `releaseWithoutPhoto`
     uses — no new column for it).
- **`guardExposureAndFunds` fix (required, not optional):** its outstanding-exposure query
  currently does `payouts.select(...).select("...order_assignments!inner(florist_id)")` — an
  INNER join, which would silently exclude every manual payout (no `assignment_id`) from the
  sum in both directions: a florist's manual payouts wouldn't count against their cap, and an
  order-leg check wouldn't see outstanding manual exposure either. The query needs to also
  pull rows matching `payouts.florist_id = floristId` directly and union the two sets before
  summing. This is what makes "same guards" in Part B actually true rather than nominal.
- `retryPayoutRow`: add an optional `actor` param, threaded into the `payment_events` payload
  on both the issued and failed branches, so a manual retry is distinguishable from an
  automatic outbox retry in the timeline.
- `PayoutOutcome.leg` widens to `"accept" | "delivery" | "manual"`.

## API routes

- **`POST /api/orders/payout/retry`** — `requireRole("finance", "admin")`. Body `{ payoutId }`.
  404 if the payout doesn't exist, 409 if its `status !== 'failed'`. Calls
  `retryPayoutRow(payoutId, actor)`. Response shape mirrors `release-without-photo`'s
  ok/reason/error contract so the client can reuse the same error-message mapping.
- **`POST /api/payouts/manual`** — `requireRole("admin")`. Body `{ floristId, amount, reason }`
  (currency fixed `"EUR"`). 400 on missing/invalid amount or empty reason. Calls
  `issueManualPayout`. Same response contract as above.

## UI

1. **Order page** (`components/orders/OrderDetailClient.tsx`) — a "Retry issue" button next to
   any payout row with `status === 'failed'`, gated by the existing `canManagePayouts`
   (finance+admin). Placed in the same payout-legs block as the current held-payout
   approve/reject buttons (`~line 673-690`).
2. **Shared "Issue a card" form** — one component, admin-only, two launch points:
   - `/florists/[id]` — new section gated on `staffRole === 'admin'` (same pattern as that
     page's existing `canViewAs`/`canSeeOperational` ops/admin gates). Florist pre-filled from
     the page context.
   - `/payments` — an "Issue a card" button (admin-only) opening the same form with a florist
     search/picker.
   Fields: florist (locked or searchable per entry point), amount (EUR, numeric), reason
   (required, free text). Submits to `POST /api/payouts/manual`.
3. **`/payments` ledger** (`components/payments/PaymentsLedger.tsx`) — an "Active cards only"
   toggle alongside the existing status `<select>`. Active = `rail === 'card'` AND
   `provider_ref` set AND not a `ledger:` sentinel AND `card_status !== 'CLOSED'` AND
   `status in ('issued', 'paid')`. The server page's query (`app/(staff)/payments/page.tsx`)
   gains a second florist lookup (`payouts.florist_id → florists(name)`) so manual-leg rows
   (which have no `order_assignments`) still show a florist name; the `Order` column shows
   `—` for them, matching how the existing table already renders a missing order.
4. **`lib/types.ts`** — `Payout.assignment_id` widens to `string | null`, add
   `florist_id?: string | null`, `leg` widens to include `"manual"`.

## `lib/lifecycle.ts`

- Bump the `payout-accept`/`payout-deliver` stages' `manual` handling text — today it reads "If
  retries exhaust, the CX hub flags 'payout stuck — settle manually'" with no action behind the
  flag; update it to describe the new "Retry issue" button on the order page as the actual
  manual path, and update `code` refs to include the new route.
- Note the new ad-hoc/manual leg as a documented addition to the money-path stages, since it's
  a new way money can move outside the order loop (relevant to anyone reading the map to
  understand "what can happen to money here").

## Error handling

Both new routes reuse the existing `none()`-style reason codes already defined in
`lib/payout.ts` (`paused`, `exposure_capped`, `insufficient_funds`, `no-tier`,
`already-issued`) — no new error vocabulary, no new client-side mapping beyond what
`release-without-photo` already established.

## Testing

Per this repo's lightweight `node --test` convention (no broad suite):

- `guardExposureAndFunds`'s fixed exposure query: a manual payout counts toward a florist's
  cap, and an order-leg check sees outstanding manual exposure for the same florist.
- The `payouts_leg_shape_check` invariant (manual ⇔ no assignment + has florist; order leg ⇔
  has assignment + no florist) — exercised at the `issueManualPayout`/`issueLeg` call level,
  not by hand-writing SQL against the constraint.
- `retryPayoutRow`'s new `actor` param lands in the `payment_events` payload without changing
  its existing return shape.
