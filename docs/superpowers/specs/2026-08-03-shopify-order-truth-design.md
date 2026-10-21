# Aligning our order status with Shopify — design

**Date:** 2026-08-03
**Status:** approved, ready to plan

## Problem

Order `#2000015` (`xxxxxxxx`) is **fulfilled and archived in Shopify** and still sits
at `received` in ours, holding a pending `escalate` approval in the CX queue. Three
independent blind spots:

1. **The `orders/updated` webhook throws the information away.** `handleOrderUpdated`
   calls `parseShopifyOrder(raw)` — which already extracts `fulfillment_status` — and
   then passes only `parsed.tags` to `refreshTagsAndMaybeMatch`. Everything else in
   the payload is discarded. The fulfilment webhook arrived and was ignored.
2. **The per-order re-pull can't learn it either.** `reconcile.ts` fetches
   `?fields=id,tags`, so "Re-pull from Shopify" is tags-only by construction.
3. **Archive isn't represented.** Shopify's archive sets `closed_at`, which neither
   parser reads.

## Decisions

| Question | Decision |
|---|---|
| What should our status do on fulfilled/archived? | Mirror it and **close our loop when nothing of ours is in flight**. With a florist already accepted, record the fact and flag a conflict — never silently close over a live payout. |
| How wide should the refresh be? | **Full**: fetch the whole order and refresh every Shopify-owned field, on both the webhook and the re-pull. A dropped webhook of any kind then self-heals, not just a dropped tag. |
| How is Shopify's lifecycle represented? | **Aligned with our existing statuses, not duplicated.** No new columns, no migration. `closed_at`/`fulfilled` map onto our `closed`; `cancelled_at` onto our `cancelled`. `fulfillment_status` stays because it is Shopify's own field and the orders list already filters on it. |

## Architecture

### 1. No migration

Shopify's archive is expressed by our `status = 'closed'`, not by a mirror column.
The `shopify_closed` order event carries which signal fired (`fulfilled`,
`archived`, or both) for audit. The one case where the fact isn't recoverable from
our status is the conflict path, where we deliberately don't move status — there
the event is the record.

### 2. `shopifyLifecycle(raw)` — new pure module

`ingest-worker/src/shopifyLifecycle.ts`, no I/O, unit-tested:

```ts
export interface ShopifyLifecycle { fulfilled: boolean; archived: boolean; cancelled: boolean; }
export function shopifyLifecycle(raw: unknown): ShopifyLifecycle;
```

Reads `fulfillment_status === "fulfilled"`, `closed_at != null`, `cancelled_at != null`
straight off the raw payload. Kept out of `parseShopifyOrder` deliberately: that
function's return value is written to the DB, and these are decision inputs, not
columns.

### 3. `orderClosure()` — the pure decision

Same module, so the whole rule is testable without a database:

```ts
export type ClosureAction =
  | { kind: "close"; to: "closed" | "cancelled" }
  | { kind: "conflict" }
  | { kind: "none" };

export function orderClosure(
  life: ShopifyLifecycle,
  ourStatus: string,
  hasFloristInFlight: boolean
): ClosureAction;
```

Rules:

- Shopify cancelled → `{close, to: "cancelled"}` (the existing `orders/cancelled`
  webhook already handles the unwind; this is the backstop for a dropped one).
- Not fulfilled and not archived → `none`.
- Our status already `closed`/`cancelled` → `none` (idempotent).
- A florist in flight (`accepted`/`delivered` assignment) → `conflict`.
- Otherwise → `{close, to: "closed"}`.

"In flight" is assignment-based, not status-based, because in semi mode a matched
order rests at `received`.

### 4. Refresh — `refreshTagsAndMaybeMatch` → `refreshFromShopify`

Same idempotent helper both callers converge on, now doing three things in order:

1. **Refresh Shopify-owned columns.** An explicit allow-list — NOT
   `upsertOrder(parsed.order)`, because `parseShopifyOrder` hard-codes
   `status: "received"` and a blind upsert would rewind every order it touched.
   `status` and `city_id` are ours and are never written here. Line items are
   replaced through the existing `replaceLineItems`, so the payout basis tracks an
   edited order. Keeps the existing `tags_updated` event when tags change.
2. **Closure.** Apply `orderClosure`. On `close`: set the status, move pending
   `order_approvals` rows to `skipped`, write `shopify_closed`. On `conflict`:
   write `shopify_conflict` once (skip if one already exists) and leave status alone.
3. **Late match.** Unchanged — still gated on `status === "received"`, the active-tag
   gate, and the already-matched guard. Unreachable when step 2 just closed the
   order, which is the correct ordering.

### 5. Callers

- **`handleOrderUpdated`** — costs nothing extra; it already has the full order and
  simply stops discarding it.
- **`reconcileOneOrder`, `selfHealParkedOrders`, `backfillMissingTags`** — swap
  `fetchShopifyTags` (`?fields=id,tags`) for a full `fetchShopifyOrder`. Same request
  count, larger payloads.

### 6. CX surface

Resolving the pending approval drops the order out of `/cx` for free —
`gatherAttention` builds its reasons from pending `order_approvals`. The conflict
case needs a new attention reason (Shopify says done while our florist is
mid-delivery), which is the one genuinely new query.

### 7. Tests

`node --test` / vitest, matching each package's existing convention:

- `shopifyLifecycle` — fulfilled/archived/cancelled extraction off realistic payload shapes.
- `orderClosure` — table-driven over lifecycle × our-status × in-flight, including
  idempotency (already `closed` → `none`) and the conflict precedence.
- The existing `reconcileTagBackfill.test.ts`, updated for the wider fetch.

### 8. Lifecycle map

A branch for "Shopify fulfilled/archived outside our loop" and one for the conflict
case, plus a note on `reachout-*`/intake that the re-pull is now a full refresh.

## Out of scope

- No change to the `orders/cancelled` unwind — the closure path only backstops a
  dropped one by setting status.
- No Shopify write-back changes.
- No notification to anyone when an order auto-closes; the event + its disappearance
  from the queues is the signal.

---

## Addendum — reconciling EVERY order (2026-08-03)

The design above heals orders as Shopify tells us about them, plus a ~14d
windowed sweep. That leaves the existing backlog untouched: at the time of
writing, **3,622 orders**, of which **1,103 are older than the sweep window** and
**3,607 sit open** (1,846 `escalated`, 1,761 `received`) against a Shopify that
has long since fulfilled or archived many of them.

### Decision

A full-table catch-up sweep, **armed deliberately** and **dry-runnable first** —
a pass that could close orders in the thousands should be a decision made on
evidence, not on hope.

### Shape

- `app_settings.reconcile_all_mode` (`null` | `dry` | `apply`), a
  `(reconcile_all_after_created_at, reconcile_all_after_id)` cursor, and a
  `reconcile_all_stats` jsonb blob. Migration:
  `supabase/migrations/2026-08-03-reconcile-all-orders.sql`.
- `reconcileAllOrders(env)` runs on the **existing per-minute cron**, deliberately
  outside `reconcileMissingOrders`' hourly throttle — throttled, a full pass would
  take days. 60 orders/tick ≈ an hour for the whole table.
- **Keyset pagination on `(created_at, id)`.** The id tiebreak is load-bearing:
  bulk imports write many rows in one transaction and so share a `created_at` to
  the microsecond, and a timestamp-only cursor silently skips the rest of any such
  group whenever a batch boundary lands inside it. `created_at` (ours, NOT NULL)
  rather than `shopify_created_at`, which the schema permits to be null.
- **Same implementation as everything else.** `apply` routes each order through
  `refreshFromShopify` — the same primitive the webhook and the re-pull use.
  `dry` calls the identical pure decision (`shopifyLifecycle` + `orderClosure`)
  and stops before writing, so a dry run provably reports what the real pass does.
- Armed via `POST /reconcile {all: "dry"|"apply"|"stop"}` on the worker, fronted by
  the admin-gated `/api/orders/reconcile`, with controls and live totals on the
  orders page.

### Out of scope

- No per-order progress UI beyond the running totals.
- No automatic re-arming: it is a catch-up tool, not a background behaviour.
