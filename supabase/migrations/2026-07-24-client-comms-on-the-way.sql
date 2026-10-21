-- Communications hub, Workstream C: the "on the way" customer notice
-- (out_for_delivery). client_comms enforces idempotency per (order_id, kind);
-- extend its check constraint to allow the new kind alongside the existing
-- 'assigned'/'delivered'.
alter table client_comms drop constraint if exists client_comms_kind_check;
alter table client_comms add constraint client_comms_kind_check
  check (kind in ('assigned', 'on_the_way', 'delivered'));
