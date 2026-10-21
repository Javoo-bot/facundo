-- Missing-webhook reconciliation sweep: a throttle timestamp on the singleton
-- app_settings row. The worker's cron reads/claims this so the reconciliation
-- (pull recent Shopify orders, backfill any we never received) runs ~hourly
-- rather than every minute. Nullable = "never run yet".
alter table app_settings add column if not exists reconcile_last_run_at timestamptz;
