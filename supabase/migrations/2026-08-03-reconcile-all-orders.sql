-- Full-table Shopify reconcile: state for a resumable sweep over EVERY order.
-- Spec: docs/superpowers/specs/2026-08-03-shopify-order-truth-design.md
--
-- The two existing sweeps (selfHealParkedOrders, backfillMissingTags) are
-- bounded to a ~14d window and capped per tick, so orders older than that were
-- never reachable — 1,103 of 3,622 at the time this landed, with 3,607 sitting
-- open (1,846 escalated, 1,761 received) against a Shopify that had long since
-- fulfilled or archived many of them.
--
-- This is a one-shot-per-arming pass driven by the SAME per-minute cron and the
-- SAME refreshFromShopify primitive. It walks the table oldest-first in capped
-- batches, remembering where it got to, and disarms itself at the end.

-- null = not running. 'dry' = report what would change, write nothing.
-- 'apply' = the real thing.
alter table app_settings add column if not exists reconcile_all_mode text
  check (reconcile_all_mode is null or reconcile_all_mode in ('dry', 'apply'));

-- Position in the (shopify_created_at, id) ordering — the last order finished.
-- Null with a non-null mode means "start from the beginning".
alter table app_settings add column if not exists reconcile_all_after_created_at timestamptz;
alter table app_settings add column if not exists reconcile_all_after_id uuid;

-- Running totals for the armed pass, reset when it's armed. Shape:
--   { swept, closed, conflicts, noChange, errors, startedAt, finishedAt }
-- In 'dry' mode `closed`/`conflicts` are what WOULD happen — nothing is written.
alter table app_settings add column if not exists reconcile_all_stats jsonb;
