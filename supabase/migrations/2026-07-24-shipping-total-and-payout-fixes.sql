-- Real Shopify order total already nets in tax/discounts, but the florist
-- payout formula is deliberately items + delivery only (a discount code
-- shouldn't reduce what the florist gets for the same physical work). Needs
-- shipping captured separately since order.total alone can't be decomposed.
alter table orders add column if not exists shipping_total numeric;
