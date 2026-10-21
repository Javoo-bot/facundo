-- CX single-point-of-failure alert sweep (x-cx-spof in dashboard/lib/lifecycle.ts).
-- POST /api/cx/alert-sweep pages a human (email + web-push) when SLA-breaching /
-- high-urgency CX work is sitting unattended, throttled so a busy queue doesn't
-- re-page every cron tick.

-- 1. Throttle state on the app_settings singleton row --------------------------
-- last_sent_at: when we last actually sent an alert (email and/or push).
-- last_hash: a stable signature of the breaching order set at last send, so an
-- UNCHANGED breaching set only re-alerts once per throttle window, while a
-- CHANGED set (new order breached, or the old one cleared) re-alerts immediately
-- regardless of the window — see dashboard/lib/cxAlerts.ts.
alter table app_settings add column if not exists cx_alert_last_sent_at timestamptz;
alter table app_settings add column if not exists cx_alert_last_hash text;

-- 2. Staff web-push subscriptions ----------------------------------------------
-- Mirrors push_subscriptions (florist offer pushes) but keyed by the signed-in
-- staff email rather than a florists.id — staff aren't florists. Written only by
-- the service-role route POST /api/staff/push-subscribe (allow-list gated); read
-- by the alert sweep (service-role) to fan out the page.
create table if not exists staff_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists staff_push_subscriptions_email_idx on staff_push_subscriptions(email);

alter table staff_push_subscriptions enable row level security;
-- A staff member can see their own subscribed devices (e.g. a future "manage
-- devices" UI); inserts/deletes stay service-role-only via the route + the
-- sweep's dead-subscription pruning.
create policy "allowlisted reads own staff_push_subscriptions" on staff_push_subscriptions
  for select to authenticated
  using (email = auth.jwt()->>'email');
