-- Florist SMS — order offers + recruiting outreach.
-- See docs/superpowers/specs/2026-08-03-florist-sms-design.md.
--
-- SMS is a THIRD channel, additive to email + push. It closes the
-- `reachout-comms-fail` branch in dashboard/lib/lifecycle.ts ("Add
-- WhatsApp/SMS as a third channel"), where a florist with a bounced email
-- AND a dead push subscription was previously unreachable.

-- 1. Widen the unified communications log to carry SMS.
alter table communications drop constraint if exists communications_channel_check;
alter table communications add constraint communications_channel_check
  check (channel in ('email', 'push', 'sms'));

-- 2. Widen the recruiting-outreach log to carry SMS.
alter table outreach drop constraint if exists outreach_channel_check;
alter table outreach add constraint outreach_channel_check
  check (channel in ('email', 'sms'));

-- 3. Per-kind SMS toggles. Unlike the email_*_enabled columns (which default
-- TRUE and fail OPEN), these default FALSE: SMS ships dark and is switched on
-- explicitly from Settings → Notifications once Telnyx is configured and a
-- test send has been verified. dashboard/lib/smsToggles.ts fails CLOSED to
-- match — only an explicit TRUE sends.
alter table app_settings
  add column if not exists sms_offer_enabled      boolean not null default false,
  add column if not exists sms_recruiting_enabled boolean not null default false;

comment on column app_settings.sms_offer_enabled is
  'Florist offer SMS (dashboard/lib/reachoutSend.ts::sendOffer). Off = the offer still goes out via email + push; the atomic claim/status update are unaffected. Defaults FALSE (ships dark).';
comment on column app_settings.sms_recruiting_enabled is
  'Florist recruiting/outreach SMS (dashboard/app/api/outreach/send/route.ts, channel=sms). Off = an SMS batch is skipped and logged, nothing is sent. Defaults FALSE (ships dark).';

-- 4. SMS opt-out, tracked SEPARATELY from order_emails_opt_out. A florist may
-- tolerate texts while ignoring email, or the reverse; conflating them would
-- silently suppress a channel they never opted out of.
alter table florists
  add column if not exists order_sms_opt_out        boolean not null default false,
  add column if not exists order_sms_snoozed_until  timestamptz;

comment on column florists.order_sms_opt_out is
  'Permanent opt-out from order-offer SMS, set from /florist/unsubscribe/[token]. Independent of order_emails_opt_out.';
comment on column florists.order_sms_snoozed_until is
  'Temporary (30-day) snooze from order-offer SMS. Independent of order_emails_snoozed_until.';

-- 5. LLM-drafted recruiting SMS, the SMS sibling of florists.drafted_email.
alter table florists add column if not exists drafted_sms text;

comment on column florists.drafted_sms is
  'Generated recruiting-outreach SMS draft (dashboard/lib/draftSms.ts). Short plain text, no subject — the SMS sibling of drafted_email.';
