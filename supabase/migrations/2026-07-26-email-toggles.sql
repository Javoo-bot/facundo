-- Per-email-type on/off toggles: staff can turn each outbound email off
-- individually from Settings → Notifications without touching test mode or
-- the payments kill switch. Each toggle gates the EMAIL SEND ONLY — the
-- non-email side of the same loop (push, atomic claim, status updates) is
-- never affected by these columns; see the gate call sites:
--   - dashboard/lib/reachoutSend.ts::sendOffer            (email_offer_enabled)
--   - dashboard/lib/clientComms.ts::notifyClient          (email_client_{assigned,on_the_way,delivered}_enabled)
--   - dashboard/lib/issueComms.ts::notifyFloristOfIssue   (email_issue_to_florist_enabled)
--   - dashboard/lib/issueComms.ts::notifyCxOfIssue        (email_issue_to_cx_enabled)
--   - dashboard/lib/cxAlerts.ts::sweepCxAlerts            (email_cx_alert_enabled — push still fires when off)
--   - dashboard/app/api/outreach/send/route.ts            (email_recruiting_enabled)
--
-- All default TRUE (enabled) so this migration changes no behavior until a
-- staff member explicitly flips one off. The deliverability probe
-- (app/api/settings/test-email) is intentionally NOT gated by any of these —
-- it must always be available to verify sending works.
alter table app_settings
  add column if not exists email_offer_enabled              boolean not null default true,
  add column if not exists email_client_assigned_enabled     boolean not null default true,
  add column if not exists email_client_on_the_way_enabled   boolean not null default true,
  add column if not exists email_client_delivered_enabled    boolean not null default true,
  add column if not exists email_issue_to_florist_enabled    boolean not null default true,
  add column if not exists email_issue_to_cx_enabled         boolean not null default true,
  add column if not exists email_cx_alert_enabled            boolean not null default true,
  add column if not exists email_recruiting_enabled          boolean not null default true;

comment on column app_settings.email_offer_enabled is
  'Florist offer email (dashboard/lib/reachoutSend.ts::sendOffer). Off = the offer still goes out via push only; the atomic claim/status update are unaffected.';
comment on column app_settings.email_client_assigned_enabled is
  'Client "order assigned" notice (dashboard/lib/clientComms.ts::notifyClient, kind=assigned). Off = skipped, and the per-(order,kind) idempotency claim is NOT taken, so turning it back on still allows one send.';
comment on column app_settings.email_client_on_the_way_enabled is
  'Client "on the way" notice (dashboard/lib/clientComms.ts::notifyClient, kind=on_the_way). Same off-semantics as email_client_assigned_enabled.';
comment on column app_settings.email_client_delivered_enabled is
  'Client "delivered" notice (dashboard/lib/clientComms.ts::notifyClient, kind=delivered). Same off-semantics as email_client_assigned_enabled.';
comment on column app_settings.email_issue_to_florist_enabled is
  'Email to the florist when CX replies/resolves an issue (dashboard/lib/issueComms.ts::notifyFloristOfIssue). Off = skipped; the issue thread itself is unaffected.';
comment on column app_settings.email_issue_to_cx_enabled is
  'Email to CX/ops when a florist opens/replies to an issue (dashboard/lib/issueComms.ts::notifyCxOfIssue). Off = skipped; the issue thread itself is unaffected.';
comment on column app_settings.email_cx_alert_enabled is
  'CX SLA breach alert email (dashboard/lib/cxAlerts.ts::sweepCxAlerts). This is a safety alert for stuck orders/money — leave on unless testing. Off only stops the EMAIL leg; the staff web-push still fires.';
comment on column app_settings.email_recruiting_enabled is
  'Florist recruiting/outreach emails (dashboard/app/api/outreach/send/route.ts). Off = the whole batch is skipped and logged, nothing is sent.';
