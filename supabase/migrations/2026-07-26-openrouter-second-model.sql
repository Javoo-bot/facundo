-- Extends the shadow-mode OpenRouter opinion (2026-07-26-openrouter-photo-score.sql)
-- from one model to two, both still SHADOW/evaluation-only — neither
-- participates in `verdict`/combineVerdicts (dashboard/lib/photoVerify/combine.ts)
-- and neither gates payout (dashboard/lib/payout.ts).
--
-- `google/gemini-2.5-pro` was the original pick. `qwen/qwen3-vl-30b-a3b-instruct`
-- is added as a cheap, genuinely independent second opinion (different model
-- lineage from both Claude and Gemini, purpose-built for general visual
-- reasoning) so the shadow data can show agreement/disagreement between two
-- OpenRouter-routed models, not just one — a first step toward the eventual
-- "replace the validation with AI" decision, not that decision itself.
--
-- Renames the original singular openrouter_* columns to openrouter_gemini_* for
-- symmetry with the new openrouter_qwen_* set (safe: this feature merged only
-- moments ago, nothing reads these columns yet — see dashboard/app/api/florist/photo/route.ts).

alter table photo_verifications rename column openrouter_score to openrouter_gemini_score;
alter table photo_verifications rename column openrouter_matched to openrouter_gemini_matched;
alter table photo_verifications rename column openrouter_confidence to openrouter_gemini_confidence;
alter table photo_verifications rename column openrouter_notes to openrouter_gemini_notes;
alter table photo_verifications rename column openrouter_model to openrouter_gemini_model;
alter table photo_verifications rename column openrouter_ok to openrouter_gemini_ok;
alter table photo_verifications rename column openrouter_error to openrouter_gemini_error;

alter table photo_verifications add column if not exists openrouter_qwen_score numeric;       -- 0..100, nullable
alter table photo_verifications add column if not exists openrouter_qwen_matched boolean;
alter table photo_verifications add column if not exists openrouter_qwen_confidence numeric;  -- 0..1, shape-parity with the other providers
alter table photo_verifications add column if not exists openrouter_qwen_notes text;
alter table photo_verifications add column if not exists openrouter_qwen_model text;           -- e.g. 'qwen/qwen3-vl-30b-a3b-instruct'
alter table photo_verifications add column if not exists openrouter_qwen_ok boolean;           -- false = call errored/skipped; null = didn't run at all
alter table photo_verifications add column if not exists openrouter_qwen_error text;
