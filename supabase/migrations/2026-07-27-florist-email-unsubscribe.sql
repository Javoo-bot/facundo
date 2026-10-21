-- Florist self-service order-email unsubscribe (pause 30 days or stop
-- completely) + a per-deployment support-contact override for the offer
-- email footer. Additive/nullable-or-defaulted — no existing send behavior
-- changes until a florist actually hits unsubscribe, or staff sets the
-- support email in Settings.
alter table florists
  add column if not exists order_emails_snoozed_until timestamptz,
  add column if not exists order_emails_opt_out boolean not null default false,
  add column if not exists unsubscribe_token text unique;

comment on column florists.order_emails_snoozed_until is
  'Florist self-service "pause 30 days" (dashboard/app/florist/unsubscribe). Null = not snoozed; a future timestamp = order-offer emails suppressed until then (auto-resumes, no cron needed). Checked in dashboard/lib/reachoutSend.ts::sendOffer.';
comment on column florists.order_emails_opt_out is
  'Florist self-service "stop completely" (dashboard/app/florist/unsubscribe). Permanent — no self-service re-opt-in; staff can clear it directly in the DB if a florist asks to come back. Checked in dashboard/lib/reachoutSend.ts::sendOffer.';
comment on column florists.unsubscribe_token is
  'Opaque token for the no-login unsubscribe link in the offer email footer. Generated lazily on first offer send (dashboard/lib/reachoutSend.ts::sendOffer), never backfilled.';

alter table app_settings
  add column if not exists florist_support_email text;

comment on column app_settings.florist_support_email is
  'Support contact shown in the florist order-offer email footer (Settings). Null falls back to the hardcoded default in dashboard/lib/reachoutSend.ts.';
