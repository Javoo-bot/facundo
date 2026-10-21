-- Soft-delete for orders (admin-only, see /api/orders/delete). Hides an order
-- from the staff orders list without destroying its history (line items,
-- assignments, payouts) — a real order can have money already paid to a
-- florist, so a hard delete would be destructive and auditors would lose the
-- trail. `deleted_at` null = visible (the default, unaffected for every
-- existing row); set = hidden from the list, still reachable by direct link
-- (shows a "Deleted" banner + Restore action there).
alter table orders add column if not exists deleted_at timestamptz;
