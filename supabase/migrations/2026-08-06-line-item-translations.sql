-- What a florist READS on an offer, in their own language.
--
-- Our own UI chrome has been localised into six locales since
-- 2026-07-26-florist-frontend-i18n, but everything that comes FROM SHOPIFY —
-- the product title, the bouquet recipe, the components and add-on lists — has
-- always rendered in the shop's primary locale. A florist in Girona reads
-- "12 Freedom rose 50cm" in English and has to work it out.
--
-- Shopify already holds translations for all of it (Translate & Adapt, 9
-- published locales), including the `custom.recipe` metafield. Measured over
-- the 143 recipe-carrying variants that appear in our 1000 real production line
-- items: 120 (83%) are translated for es/fr/de/it/pl, 138 (96%) for pt-BR. So
-- Shopify is the first source. The remaining ~17% is filled by a model call and
-- cached here, which is what this table is for.
--
-- KEYED BY A HASH OF THE ENGLISH SOURCE, not by a Shopify resource id, because:
--
--   1. It self-invalidates. Shopify translations go stale silently — 6 of those
--      120 recipes carry `outdated: true`, and one of them says 15 roses where
--      the English source says 12 AND drops "Chocolates Lindt Box" and "White
--      Vase" entirely. Hashing the source means a changed recipe can never be
--      served from a translation of the recipe it used to be.
--   2. `components`/`addons` are comma-joined product titles with no resource
--      id of their own, so there is nothing else to key them by.
--   3. Identical strings across products (every "White Vase") share one row and
--      one model call.
--
-- No expiry: a row is immutable and correct for its source text forever. The
-- only way to invalidate is for the source to change, which changes the hash.

create table if not exists content_translations (
  id          uuid primary key default gen_random_uuid(),
  -- Which line-item field this is. Not used for lookup (the hash is enough) but
  -- it keeps the table readable and lets us re-run one field's fills later.
  field       text not null check (field in ('title', 'recipe', 'components', 'addons')),
  source_hash text not null,
  locale      text not null,
  value       text not null,
  -- 'shopify' = Translate & Adapt's own copy; 'llm' = drafted by us because
  -- Shopify had none (or had one it flags as outdated).
  provider    text not null check (provider in ('shopify', 'llm')),
  -- The English it was translated FROM. Debugging only — the hash is the key —
  -- but without it a wrong translation is very hard to trace back.
  source_text text,
  created_at  timestamptz not null default now(),
  unique (field, source_hash, locale)
);

create index if not exists content_translations_lookup_idx
  on content_translations(locale, source_hash);

-- RLS with NO policies at all: this is read and written exclusively by
-- server-side code holding the service-role key (lib/translations/lineItems.ts),
-- which bypasses RLS. Enabling it without policies makes that explicit and
-- denies the anon key by default rather than by omission.
alter table content_translations enable row level security;

-- The Shopify variant behind a line item.
--
-- We already resolve a variant id at intake to fetch the image/recipe/barcode
-- (ingest-worker/src/shopifyImages.ts), but we have never STORED it — only
-- `catalog_id`, which is the product id. Translating the recipe needs the
-- variant's metafield id, which is only reachable from the variant, so without
-- this the lookup would have to guess which variant of a product a line belongs
-- to. Nullable: every row imported before this migration has none, and those
-- fall through to the model-drafted path rather than failing.
alter table order_line_items add column if not exists variant_id text;
