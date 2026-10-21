-- Order working set — generalises the active-order-tags gate (2026-07-26) from
-- "tags only" to "tags UNION an explicit per-order pick".
--
-- Staff pull every order from Shopify as before; the working set is what they've
-- said they want the system to actually operate on. Two ways in, unioned:
--   1. app_settings.active_order_tags  — the standing tag gate (unchanged)
--   2. orders.worklist_at              — an explicit pick, set from the Settings
--                                        paste box or by ticking rows on /orders
--
-- Semantics (dashboard/lib/workingSet.ts + ingest-worker/src/workingSet.ts
-- ::isInWorkingSet — the single source of truth, mirrored in both builds):
--   - No tags AND no explicit picks  = NO filtering. Every order is matched and
--     shown, exactly as before this column existed. Backward-compatible default.
--   - Otherwise the gate is ON and admits the UNION: an order passes if its
--     Shopify tags intersect active_order_tags, OR worklist_at is not null.
--
-- The "off only when BOTH are empty" rule is deliberate. Treating empty tags as
-- "everything" would make a union with an explicit list a no-op — the list would
-- do nothing in exactly the mode where staff most want it (work these two orders
-- and nothing else).
--
-- Orders that don't pass stay ingested at status 'received' — visible in the full
-- orders list, just not auto-worked. Identical to the tag gate's contract.

alter table orders add column if not exists worklist_at timestamptz;
alter table orders add column if not exists worklist_by text;

comment on column orders.worklist_at is
  'Non-null = staff explicitly picked this order to be operated on (the working set), unioned with app_settings.active_order_tags. Cleared automatically by the reconcile sweep once the order reaches a terminal state. Removing it never rewinds work already in flight.';
comment on column orders.worklist_by is
  'Email of the staff member who added this order to the working set. Audit only — the authoritative trail is the worklist_added / worklist_removed order_events rows.';

-- Partial: the working set is a handful of rows out of thousands, so the index
-- only carries the picked ones.
create index if not exists orders_worklist_idx on orders(worklist_at) where worklist_at is not null;

-- ---------------------------------------------------------------------------
-- Performance indexes (see docs/superpowers/specs/2026-08-11-order-working-set-
-- and-perf-design.md). Measured on the real DB: 5,442 orders, 6,264 florists,
-- 21,565 order_events. `orders` carried indexes only on (status) and (city_id),
-- so the list's default sort and every delivery-window filter were seq scans.
--
-- Built WITHOUT `concurrently`: at this size each takes milliseconds, and the
-- whole file is meant to run as one transaction in the SQL editor (CREATE INDEX
-- CONCURRENTLY cannot). If `orders` ever grows to where a brief write lock
-- matters, split these out and build them concurrently instead.
-- ---------------------------------------------------------------------------

-- The orders list's default query: `deleted_at is null` ordered by
-- shopify_created_at desc.
create index if not exists orders_deleted_created_idx
  on orders(deleted_at, shopify_created_at desc);

-- Delivery-window filters (from/to) and the "late" attention scan.
create index if not exists orders_delivery_at_idx on orders(delivery_at);

-- The tag half of the working set is matched with `tags ilike '%…%'`, whose
-- LEADING wildcard no btree can serve — so the orders list seq-scanned even
-- with orders_deleted_created_idx in place. A trigram GIN index is what makes
-- that predicate indexable. Measured warm on 5,442 orders: the list query
-- 11.3ms -> 1.7ms and its exact-count companion 10.4ms -> 0.4ms, with the seq
-- scan gone. (`orders.tags` is a single comma-separated string from Shopify —
-- see lib/orderTags.ts — which is why this is a substring match at all.)
create extension if not exists pg_trgm;
create index if not exists orders_tags_trgm_idx on orders using gin (tags gin_trgm_ops);

-- gatherAttention scans order_events by type for the Shopify-conflict pair;
-- 21,565 rows, seq-scanned on every staff page render.
create index if not exists order_events_type_idx on order_events(type);

-- The orders list hydrates assignments per page, /florists aggregates by
-- florist, and payouts are joined back through assignment_id.
create index if not exists order_assignments_order_idx   on order_assignments(order_id);
create index if not exists order_assignments_florist_idx on order_assignments(florist_id);
create index if not exists payouts_assignment_idx        on payouts(assignment_id);

-- ---------------------------------------------------------------------------
-- florist_workload — the per-florist counters /florists used to compute by
-- pulling EVERY order_assignments row and EVERY paid payout and reducing in JS.
-- Status buckets mirror the constants in app/(staff)/florists/page.tsx exactly;
-- keep them in step.
--
-- security_invoker so the view is read under the caller's RLS (the dashboard
-- reads it with the anon key + user JWT, like every other list query) rather
-- than the view owner's rights.
-- ---------------------------------------------------------------------------
drop view if exists florist_workload;
create view florist_workload
with (security_invoker = true) as
with asg as (
  select
    florist_id,
    count(*) filter (where status = 'accepted')                              as active_orders,
    count(*) filter (where status in ('candidate','queued','sent','opened')) as pending_offers,
    count(*) filter (where status in ('delivered','released'))               as history_count
  from order_assignments
  group by florist_id
),
-- An order leg carries the florist through its assignment; a manual ad-hoc leg
-- has no assignment and carries florist_id directly. payouts_leg_shape_check
-- guarantees exactly one is set, so coalesce picks the right one.
pay as (
  select
    coalesce(a.florist_id, p.florist_id) as florist_id,
    sum(p.amount)                        as paid_total,
    min(p.currency)                      as paid_currency
  from payouts p
  left join order_assignments a on a.id = p.assignment_id
  where p.status = 'paid'
  group by coalesce(a.florist_id, p.florist_id)
)
select
  f.id                                as florist_id,
  coalesce(asg.active_orders,  0)::int as active_orders,
  coalesce(asg.pending_offers, 0)::int as pending_offers,
  coalesce(asg.history_count,  0)::int as history_count,
  coalesce(pay.paid_total,     0)      as paid_total,
  pay.paid_currency                    as paid_currency
from florists f
left join asg on asg.florist_id = f.id
left join pay on pay.florist_id = f.id
-- Same visibility filter as the directory that reads this (and as every other
-- florist-listing query). Without it the view returns all 6,846 rows including
-- soft-deleted and permanently-excluded shops — 582 the page pages in and then
-- throws away.
where f.deleted_at is null and f.excluded_at is null
  -- ONLY florists with something to report. Measured: emitting a row per
  -- florist made this SLOWER than the JS reduce it replaced (6,264 view rows
  -- ~900 KB, against 408 assignment rows and 0 paid payouts today) — the roster
  -- is far larger than the activity on it. The reader defaults a missing
  -- florist to all-zero, so an all-zero row carries no information.
  and (
    coalesce(asg.active_orders, 0) > 0
    or coalesce(asg.pending_offers, 0) > 0
    or coalesce(asg.history_count, 0) > 0
    or coalesce(pay.paid_total, 0) <> 0
  );

-- ---------------------------------------------------------------------------
-- florist_summary — the five roster-wide aggregates the staff home page shows
-- in its Supply-health zone. It used to compute these in the browser from
-- `florists.select("*")` over the whole roster: 6,264 rows at ~1.8 KB each,
-- ~11.4 MB pulled through PostgREST and the RSC payload on EVERY home render,
-- to render five numbers. Now one row.
--
-- Filters mirror every other florist-listing query in the dashboard
-- (deleted_at / excluded_at null) and lib/stats.ts::aggregateFlorists's
-- definitions of "reachable" and "drafts ready" exactly — keep them in step.
--
-- NOTE the `<> ''` guards. The JS this replaces tests truthiness
-- (`f.email || f.phone_maps || f.phone_web`), where an EMPTY STRING is falsy;
-- SQL's `is not null` is not. 821 florists carry `phone_maps = ''` today, so a
-- plain null-check would report 6,264 reachable where the page had always said
-- 5,492 — a stat that looks better and is wrong. drafted_email is deliberately
-- NOT guarded that way; see its own note below.
-- ---------------------------------------------------------------------------
drop view if exists florist_summary;
create view florist_summary
with (security_invoker = true) as
select
  count(*)::int                                                                    as total_florists,
  count(*) filter (
    where coalesce(email, '') <> ''
       or coalesce(phone_maps, '') <> ''
       or coalesce(phone_web, '') <> ''
  )::int                                                                           as total_reachable,
  count(*) filter (where is_ecommerce is true)::int                                as total_ecommerce,
  -- `is not null`, NOT a <> '' guard: aggregateFlorists tests `!= null` here,
  -- so an empty draft would count for both. (No row carries one today, checked
  -- against the live table — this is about staying an exact twin, not data.)
  count(*) filter (where drafted_email is not null)::int                           as drafts_ready,
  avg(rating) filter (where rating is not null)                                    as overall_avg_rating
from florists
where deleted_at is null and excluded_at is null;

comment on view florist_summary is
  'Roster-wide florist aggregates for the staff home Supply-health zone. Replaces shipping the whole roster to the browser. Mirrors lib/stats.ts::computeGlobalSummary.';

comment on view florist_workload is
  'Per-florist operational counters for the /florists directory. Replaces a full-table read of order_assignments + payouts reduced in JS. Status buckets mirror app/(staff)/florists/page.tsx.';
