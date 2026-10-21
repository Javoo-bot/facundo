-- What each agent was shown, stored next to the answer it gave. Extends
-- 2026-10-13-agent-run-context.sql (Concierge, conversation_messages.ai_context)
-- to every agent whose answer already lands in a row. Each column holds the
-- prompt(s) sent, the model and the hash of the rules in agents/thinking/<id>.md.
-- Null on rows written before this, and where no model ran.
--
-- Cupid shares conversation_messages.ai_context with Concierge (no change here).
-- Bloom and Oracle have no row that keeps their answer; their Langfuse trace is
-- the record.

-- Sherlock: the prompts behind email, phone_web, owner_name and is_ecommerce.
alter table florists add column if not exists enrichment_ai_context jsonb;

-- Quill: the prompt behind drafted_email.
alter table florists add column if not exists drafted_email_context jsonb;

-- Scout: the prompt behind a country's search words.
alter table country_keywords add column if not exists ai_context jsonb;

-- Babel: the prompt behind a model-written line-item translation.
alter table content_translations add column if not exists ai_context jsonb;

-- Polyglot: the prompt behind a machine-drafted template translation. Cleared
-- when a person edits the draft.
alter table message_override_drafts add column if not exists ai_context jsonb;

-- Hawkeye: each vision model's prompt (the photo itself stays in R2 under
-- photo_key).
alter table photo_verifications add column if not exists ai_context jsonb;
