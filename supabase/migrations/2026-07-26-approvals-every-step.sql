-- Semi-auto, generalized: every system-initiated transition (not just the offer)
-- files a previewed order_approvals row in workflow_mode='semi'. Widen the table
-- from the offer-only shape (2026-07-15-step-mode-approvals.sql) to carry any step
-- kind plus a rendered preview + the payload an executor needs to run it on approve.
--
-- Money is NOT modelled here — the 70%/30% legs keep their existing payouts.status
-- ='held' hold-and-release mechanism; the cockpit merely renders held payouts
-- alongside these approvals. See docs/superpowers/specs/2026-07-26-semi-auto-approvals-design.md.

-- 1. Widen `kind` from ('offer') to every gated step kind.
alter table order_approvals drop constraint if exists order_approvals_kind_check;
alter table order_approvals add constraint order_approvals_kind_check
  check (kind in (
    'match', 'offer', 'reassign', 'escalate', 'writeback',
    'client_assigned', 'client_on_the_way', 'client_delivered'
  ));

-- 2. Structured preview (what CX sees) + payload (what the executor needs) + a
--    per-effect dedupe key so overlapping wave ticks / retries never double-file.
alter table order_approvals add column if not exists preview     jsonb;
alter table order_approvals add column if not exists payload      jsonb;
alter table order_approvals add column if not exists dedupe_key   text;

-- Backfill a dedupe key for any existing pending offer rows so the new unique index
-- below can be created without collisions (one pending offer per order historically).
update order_approvals
  set dedupe_key = 'offer:' || order_id::text || ':' || coalesce(assignment_id::text, 'none')
  where dedupe_key is null;

-- 3. Swap the "one pending approval per order" invariant for "one pending approval
--    per effect": an order now legitimately has several pending approvals at once
--    (e.g. on accept: client_assigned + writeback), each unique on its dedupe_key.
drop index if exists order_approvals_pending_uidx;
create unique index if not exists order_approvals_pending_dedupe_uidx
  on order_approvals (dedupe_key) where status = 'pending';
