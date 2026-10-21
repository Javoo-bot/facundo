-- Late accept + configurable offer window.
-- Spec: docs/superpowers/specs/2026-08-03-late-accept-and-configurable-offer-window-design.md
--
-- Two changes, both inert on their own:
--   1. The offer window moves out of code (dashboard/lib/reachout.ts::
--      suggestedTimeoutMinutes) and into settings. Defaults below are that
--      function's existing ladder, so applying this migration changes nothing
--      until someone edits the values in Settings → Offers.
--   2. `order_assignments.withdrawn_at` — the flag behind the new staff
--      "Withdraw offer" action, and the reason an otherwise-acceptable lapsed
--      offer stays closed. NOTE: this column already exists in the live
--      database but was never captured in a migration; `if not exists` makes
--      this a no-op there while letting a fresh project reproduce production.

-- Offer window per urgency tier, in minutes (delivery lead time → how long the
-- florist has to respond).
alter table app_settings add column if not exists offer_window_rush_min      integer not null default 15;   -- delivery <= 6h
alter table app_settings add column if not exists offer_window_sameday_min   integer not null default 30;   -- <= 24h
alter table app_settings add column if not exists offer_window_standard_min  integer not null default 60;   -- <= 72h
alter table app_settings add column if not exists offer_window_far_min       integer not null default 120;  -- beyond 72h
alter table app_settings add column if not exists offer_window_nodate_min    integer not null default 60;   -- order has no delivery_at

-- How close to delivery a lapsed offer stops being acceptable. Default 2h
-- matches the existing sla_deadline_at convention (delivery_at - 2h).
alter table app_settings add column if not exists late_accept_buffer_hours   integer not null default 2;

-- Staff withdrew this offer. Deliberately a timestamp rather than a new
-- `status` value: the check constraint, the AssignmentStatus union, and every
-- switch over status stay untouched, and we get the *when* for free.
alter table order_assignments add column if not exists withdrawn_at timestamptz;
