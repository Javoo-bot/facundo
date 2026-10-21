-- Self-throttle for the new Airwallex payout reconcile sweep
-- (dashboard app/api/payouts/reconcile/route.ts, lib/airwallex/reconcile.ts).
--
-- The cron poke arrives every minute (same shared-secret pattern as
-- /api/outbox/drain, /api/orders/waves/tick, /api/cx/alert-sweep — see
-- ingest-worker/src/index.ts's scheduled()), but a full sweep makes real
-- Airwallex API calls per eligible card, so it self-throttles server-side the
-- same way lib/cxAlerts.ts's `cx_alert_last_sent_at` does, rather than relying
-- on the caller to space out its pokes. A caller passing an explicit `ids`
-- list (the staff-triggered manual path) bypasses this — see the route.

alter table app_settings add column if not exists payout_reconcile_last_run_at timestamptz;
