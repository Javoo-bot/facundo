-- SHADOW/evaluation-only third opinion on the delivered-photo verification gate:
-- OpenRouter (currently model `google/gemini-2.5-pro`) also sees the ordered
-- product's reference photo(s) (backfilled onto order_line_items.image_url via
-- Shopify's GraphQL lookup — see 2026-07-24-line-item-recipe-fields.sql), not
-- just the text spec, alongside the florist's delivered photo, and reports a
-- 0-100 `score`. It is recorded here for comparison/evaluation only — it does
-- NOT participate in `verdict`/combineVerdicts (dashboard/lib/photoVerify/combine.ts)
-- and does NOT gate payout (dashboard/lib/payout.ts). A future change may
-- promote it once it's been evaluated against the existing Claude+Gemini gate.

alter table photo_verifications add column if not exists openrouter_score numeric;       -- 0..100, nullable
alter table photo_verifications add column if not exists openrouter_matched boolean;
alter table photo_verifications add column if not exists openrouter_confidence numeric;  -- 0..1, shape-parity with the other providers
alter table photo_verifications add column if not exists openrouter_notes text;
alter table photo_verifications add column if not exists openrouter_model text;          -- e.g. 'google/gemini-2.5-pro'
alter table photo_verifications add column if not exists openrouter_ok boolean;          -- false = call errored/skipped; null = didn't run at all
alter table photo_verifications add column if not exists openrouter_error text;

-- Same toggle pattern as photo_verify_claude/photo_verify_gemini (2026-07-15).
alter table app_settings add column if not exists photo_verify_openrouter boolean not null default true;
