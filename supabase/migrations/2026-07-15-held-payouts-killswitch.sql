-- Money-safety go-live gate: the 30% delivery leg is HELD for CX approval instead
-- of auto-releasing on any uploaded photo, plus a global payments kill switch.

-- 1. Allow a 'held' payout status (row exists, amount reserved, no card issued yet).
alter table payouts drop constraint if exists payouts_status_check;
alter table payouts add constraint payouts_status_check
  check (status in ('pending', 'issued', 'paid', 'failed', 'clawed_back', 'held'));

-- 2. Settings:
--    payments_paused      — global kill switch: block ALL issuance/releases.
--    hold_delivery_payouts — hold the 30% delivery leg for CX approval (default ON;
--                            turn off once the AI photo-verification gate ships).
alter table app_settings add column if not exists payments_paused boolean not null default false;
alter table app_settings add column if not exists hold_delivery_payouts boolean not null default true;

-- 3. A 'failed' (or CX-rejected → failed) payout must NOT permanently block the
--    (assignment_id, leg) slot — a failed row means no money went out, so the leg
--    must be re-issuable. Widen the uniqueness exclusion to failed as well as
--    clawed_back (both = no live money on that slot).
drop index if exists payouts_assignment_leg_uidx;
create unique index if not exists payouts_assignment_leg_uidx
  on payouts (assignment_id, leg)
  where status not in ('clawed_back', 'failed');

