-- "Thank you for accepting" — the confirmation a florist gets the moment they
-- take an order. Until now the accept produced messages for everyone EXCEPT
-- the florist: the customer got the "assigned" notice, Shopify got the
-- write-back, CX got the event — and the person who just committed to making
-- and delivering the bouquet got a screen change and nothing else.
--
-- Two toggles, following the two existing conventions exactly:
--   email_accept_confirm_enabled  defaults TRUE  (lib/emailToggles.ts fails OPEN)
--   sms_accept_confirm_enabled    defaults FALSE (lib/smsToggles.ts fails CLOSED —
--                                                 SMS costs money per segment and
--                                                 ships dark, like every other
--                                                 SMS kind here)
--
-- Send site: dashboard/lib/acceptComms.ts::notifyFloristOfAccept, called from
-- both accept paths (the florist's own POST /api/florist/respond and a staff
-- accept-on-their-behalf via POST /api/orders/reachout). Both legs are
-- best-effort: neither can fail the accept, the payout, or the write-back.
alter table app_settings
  add column if not exists email_accept_confirm_enabled boolean not null default true,
  add column if not exists sms_accept_confirm_enabled   boolean not null default false;

comment on column app_settings.email_accept_confirm_enabled is
  'Florist "thank you for accepting" email (dashboard/lib/acceptComms.ts::notifyFloristOfAccept). Off = skipped and logged; the accept, the 70% payout leg and the client notice are unaffected.';
comment on column app_settings.sms_accept_confirm_enabled is
  'Florist "thank you for accepting" SMS (same send site). FAILS CLOSED like every sms_* toggle: only an explicit true sends. Off = the email leg still goes out.';
