-- The variant name is a fifth translatable field.
--
-- Missed in the first pass because the recipe's metafield is reachable only
-- from the variant, and we hold `variant_id` on new rows only — so variant
-- content looked like it shared that limitation. It doesn't: the variant name
-- is a PRODUCT_OPTION_VALUE, reachable from the PRODUCT, and `catalog_id` (the
-- product id) is present on effectively every row we have. So this works on
-- legacy rows too.
--
-- It shows on the offer as "Endless Passion - 30 Red Roses · Best Value -
-- Deluxe", and Shopify translates it: fr "De luxe", es "De lujo". Leaving it
-- English put an untranslated fragment in the middle of an otherwise
-- translated line, which is exactly what got reported.

alter table content_translations drop constraint if exists content_translations_field_check;
alter table content_translations add constraint content_translations_field_check
  check (field in ('title', 'variant', 'recipe', 'components', 'addons'));
