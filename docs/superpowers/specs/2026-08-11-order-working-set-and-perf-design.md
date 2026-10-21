# Order working set + dashboard performance pass

**Date:** 2026-08-11
**Status:** approved, ready to implement

Two changes that travel together because both land in the orders list:

1. **Working set** — replace the single "default filter by tag" with a selection that is
   the *union* of staff-configured tags and an explicit per-order pick, editable both
   from Settings (paste a list of order numbers) and from the orders list (tick rows).
2. **Performance** — the staff pages pull far more data than they render. Narrow the
   selects, stop fetching full florist rosters eagerly, move per-florist counters into
   SQL, and add the missing indexes.

---

## Part 1 — The working set

### Today

`app_settings.active_order_tags` (a `text[]`) feeds `hasActiveTag(orderTags, activeTags)`,
duplicated verbatim in `dashboard/lib/orderTags.ts` and `ingest-worker/src/tags.ts`. It
gates four things:

| Consumer | File |
|---|---|
| Worker auto-match step | `ingest-worker/src/orderWorkflow.ts` |
| Late match (webhook fast path) | `ingest-worker/src/lateMatch.ts` |
| Reconcile sweeps (self-heal, full sweep) | `ingest-worker/src/reconcile.ts` |
| CX attention queue | `dashboard/lib/cxAttention.ts` |
| Orders list default view | `dashboard/app/(staff)/orders/page.tsx` |

Semantics today: empty `active_order_tags` ⇒ every order passes.

### Storage

A per-order column, **not** a settings array:

```sql
alter table orders add column if not exists worklist_at timestamptz;
alter table orders add column if not exists worklist_by text;
create index if not exists orders_worklist_idx on orders(worklist_at) where worklist_at is not null;
```

`worklist_at is not null` ⇒ staff explicitly picked this order to be operated on.

Rationale for a column over `app_settings.active_order_names text[]`:

- The list filter becomes an indexed predicate instead of an `ilike` over a growing
  string array.
- "Auto-drop when the order finishes" is a natural per-row lifecycle (one `UPDATE`),
  not an array rewrite that races with concurrent edits.
- The one-click-from-the-list action is a plain `UPDATE ... where id in (...)` on rows
  the UI already holds selected.
- Adding the same order twice is idempotent for free.

### Semantics

One new helper, `isInWorkingSet`, mirrored in `dashboard/lib/workingSet.ts` and
`ingest-worker/src/workingSet.ts` — the same deliberate duplication as `hasActiveTag`
today (separate builds, no shared package; change one, mirror the other).

| Active tags | Explicit picks exist? | Result |
|---|---|---|
| empty | no | **everything** — today's behavior, unchanged |
| `fulfill dominik` | no | tag matches only — today's behavior |
| `fulfill dominik` | yes | tag matches **∪** the picked orders |
| empty | yes | **only** the picked orders |

**The load-bearing decision is the last row.** "Numbers are additive to tags" read
literally would make empty-tags mean "everything", and a union with everything is a
no-op — the explicit list would do nothing in exactly the mode where staff most want
it. So the rule is:

> **The gate is off only when BOTH inputs are empty.** Once either tags or explicit
> picks are configured, the gate is on and admits the union.

This requires one global bit — "does any explicit pick exist?" — which is a single
indexed `head: true` count fetched alongside the `app_settings` read that every one of
these consumers already performs. It is fetched **once per page render / worker sweep**,
never per order.

```ts
// dashboard/lib/workingSet.ts (mirrored in ingest-worker/src/workingSet.ts)
export function isInWorkingSet(
  order: { tags: string | null; worklist_at: string | null },
  activeTags: string[],
  anyExplicitPicks: boolean,
): boolean {
  const tags = activeTags.map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0 && !anyExplicitPicks) return true; // gate off
  if (order.worklist_at != null) return true;
  return hasActiveTag(order.tags, tags);
}
```

`hasActiveTag` keeps its current contract unchanged and becomes one input to
`isInWorkingSet`. Every consumer in the table above switches to `isInWorkingSet`.

SQL-side (orders list), when the gate is on:

```
or=(worklist_at.not.is.null,tags.ilike.*fulfill dominik*,...)
```

Verified against the real database: PostgREST accepts `not.is.null` inside `or()` (200).

### Editing the working set

**Orders list — "Add orders by number"** — a paste box on `/orders`.

> Moved here from Settings after review. Settings is admin-only, so gating half
> the working set behind it meant an ops user could tick rows one at a time but
> could not hand over a list — which is the whole point of the feature. Every
> other way of driving the working set already lives on this page and is open to
> all staff; this now matches. Settings keeps the tags only.

- Accepts `#2000018, #2000026`, newline- or comma-separated, `#` optional.
- Resolves order *names* to ids and reports what it could not find, e.g.
  `2 of 5 not found — not pulled from Shopify yet`. It does not silently drop them.
- Viewing and unpicking happen on the same page: the "Working set: N" chip
  filters to exactly the picked orders, and ticking them offers "Remove from
  working set". No separate list to keep in step.

**Orders list — row ticking** — reuses the checkboxes that already exist for admin bulk-delete
(`components/orders/OrdersClient.tsx`), promoted from admin-only to all staff *for this
action only* (bulk delete stays admin-only). Selecting rows reveals
**Add to working set** / **Remove from working set**.

Both paths write an `order_events` row — `worklist_added` / `worklist_removed`, with
`actor` — matching how every other staff action in this codebase records itself.

### Lifecycle

The existing hourly reconcile sweep nulls `worklist_at` for any order in a terminal
state (`paid`, `closed`, `cancelled`, `delivered`), so the working set is
self-cleaning and the "Working set: N" chip stays honest. Manual removal is always
available.

**Removing an order from the working set never rewinds work in flight** — the same rule
the tag gate already follows (re-matching only ever fires on an order still at
`received`; a worked order only ever has its tags refreshed).

### Orders list UI

- The existing "hidden by tags" roll-up becomes "hidden by the working set", counting
  what the *union* holds back, and stays the safety net against the 2026-08-04 failure
  (every open order silently hidden by a stale tag set).
- A "Working set: N" chip, clickable to filter to exactly the explicit picks.
- The `tags` URL param contract is unchanged (absent ⇒ seed from config; present, even
  empty ⇒ literal), so existing bookmarks keep working.

---

## Part 2 — Performance

Measured against the real database: **5,442 orders, 6,264 florists, 408 assignments,
21,565 order events.**

| Page | Now | Cause |
|---|---|---|
| `/orders` | **571 KB** / 50 rows, 211 ms | `select("*")` pulls `raw` (the whole Shopify payload, ~13 KB/order). Narrowed: **23 KB**, 68 ms |
| `/orders` | +1,189 florist rows | full roster fetched on every load for the mock-order tool |
| `/` (home) | **~11.4 MB** | `florists.select("*")` over all 6,264 rows, 7 sequential paged round trips |
| `/discovery` | **~11.4 MB** | same query |
| `/florists` | ~1.5 MB + every assignment + every paid payout | per-florist counters reduced in JS |

`gatherAttention()` was investigated and is **not** an offender — ~191 ms of small
parallel queries. Its structure is left alone; it only gets the `order_events(type)`
index below (that table is 21,565 rows and seq-scanned today).

### Changes

1. **Narrow every list select.** `/orders` selects only the columns its table renders.
   Nothing in the dashboard reads `orders.raw` — confirmed by grep. Same treatment for
   the other list queries.
2. **Lazy rosters.** The `/orders` mock-order picker and the `/payments` card picker
   become an on-demand `GET /api/florists/options?q=` typeahead — server-side search,
   capped result set — instead of an eager full roster. Home and `/discovery` narrow
   `florists.select("*")` to the columns their summary/map actually consume.
3. **Counters in SQL.** A `florist_workload` view does the `group by` that
   `/florists` currently does in JS over two full-table paged reads. The directory
   itself gets server-side pagination + search rather than 6,264 rows in one payload.
4. **Indexes.**
   ```sql
   create index if not exists orders_deleted_created_idx on orders(deleted_at, shopify_created_at desc);
   create index if not exists orders_delivery_at_idx     on orders(delivery_at);
   create index if not exists orders_worklist_idx        on orders(worklist_at) where worklist_at is not null;
   create index if not exists order_events_type_idx      on order_events(type);
   create index if not exists order_assignments_order_idx   on order_assignments(order_id);
   create index if not exists order_assignments_florist_idx on order_assignments(florist_id);
   create index if not exists payouts_assignment_idx     on payouts(assignment_id);
   ```

---

## Keeping the lifecycle map current

`dashboard/lib/lifecycle.ts` describes the tag gate in its match stage (the
`hasActiveTag` narrative, ~line 536). That description becomes wrong the moment this
ships, so it is updated in the same change: the gate is now the working set (tags ∪
explicit picks, off only when both are empty), and the `code` refs point at
`workingSet.ts` in both builds.

## Verification

- **Migration** applied against the real database; re-run to confirm idempotence.
- **Semantics** — a unit test per row of the semantics table above
  (`lib/workingSet.test.mjs`, the existing lightweight `node --test` convention),
  including the empty-tags-with-picks row and the both-empty backward-compatible row.
- **Worker parity** — assert `dashboard/lib/workingSet.ts` and
  `ingest-worker/src/workingSet.ts` agree (the mirrored-helper trap).
- **Orders list** exercised in a real browser: pick orders by paste and by row-tick,
  confirm the list, the CX queue, and the "hidden by the working set" count all agree;
  confirm an order removed from the set keeps its in-flight work.
- **Performance** — re-measure the payload for each page in the table above and record
  before/after. Claims are not made without the measurement.

## Non-goals

- No change to how orders are pulled from Shopify (step 1 of the flow is untouched).
- No new auth surface — the working-set actions sit behind the existing staff gates.
- No rework of `gatherAttention`'s structure.
- No caching layer beyond what Supabase and React's request-scoped `cache()` already do.
