-- Configurable florist payout share (admin-editable in Settings → Payments).
-- Default 55% of the order total (incl. shipping) goes to the florist; the
-- rest is kept. Snapshot the percent actually used onto each order's
-- assignments at match time (payout_percent) so a later change to the global
-- default doesn't retroactively alter an order that was already offered —
-- clawback math on an edited/refunded order re-applies THIS stored percent,
-- not whatever the setting happens to be at clawback time.
alter table app_settings add column if not exists default_payout_percent numeric not null default 55;
alter table order_assignments add column if not exists payout_percent numeric;

-- Real Shopify order tags (e.g. "24 July 2026, fulfillment-tookan, new-customer")
-- were only ever reachable via the `raw` jsonb blob. Surface them as a plain
-- column so they're actually filterable/displayable.
alter table orders add column if not exists tags text;
