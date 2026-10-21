-- Real Shopify product/variant data a florist needs that Shopify's REST Order
-- API never carries (line items only have title/sku/price/qty) — resolved via
-- a follow-up GraphQL lookup per variant, same pattern as image_url backfill.
-- barcode is a plain variant field; the rest are `custom.*` metafields:
--   recipe        -> bouquet_spec (already existed, was always null until now)
--   components    -> list.product_reference, resolved to product titles
--   addons        -> list.product_reference, resolved to product titles
--   variant_text  -> "Includes ..." blurb shown to the customer at checkout
--   variant_icon  -> file_reference, resolved to a MediaImage URL
alter table order_line_items add column if not exists barcode text;
alter table order_line_items add column if not exists components text;
alter table order_line_items add column if not exists addons text;
alter table order_line_items add column if not exists variant_text text;
alter table order_line_items add column if not exists variant_icon_url text;
