-- Florist realm: let a florist read the line items of orders they're assigned to.
-- The florist-realm migration (2026-07-13-phase0-florist-realm.sql) added SELECT
-- policies for orders / order_assignments / delivery_events / payouts but omitted
-- order_line_items, so the florist PWA could see an order but not its bouquet
-- photo or ingredient list. This mirrors the "florist reads own orders" policy.
create policy "florist reads own line items" on order_line_items for select to authenticated
  using (order_id in (select order_id from order_assignments where florist_id = public.current_florist_id()));
