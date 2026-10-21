-- Florist-initiated "give this order back": a florist who currently holds an
-- accepted, not-yet-delivered order can hand it back (can't fulfil / going
-- dark / etc). Adds `released` as a new terminal order_assignments.status,
-- distinct from `reassigned` (which the staff/system reassign path uses) so
-- the audit trail keeps "florist gave it back" separate from "staff/SLA
-- engine moved it on". See dashboard/app/api/florist/release/route.ts and
-- dashboard/lib/waves.ts (accept-SLA auto-reoffer).
--
-- NOT applied automatically — the human applies this after review (repo convention).

alter table order_assignments drop constraint if exists order_assignments_status_check;
alter table order_assignments add constraint order_assignments_status_check
  check (status in ('candidate','queued','sent','opened','declined','expired','accepted','reassigned','delivered','released'));
