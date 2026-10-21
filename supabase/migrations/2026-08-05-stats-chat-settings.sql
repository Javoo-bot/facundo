-- Deviation from the plan's literal default: the plan's snapshot used
-- 'anthropic/claude-sonnet-4.5', but CLAUDE.md's project-wide convention is
-- "claude-sonnet-5 (default) ... do NOT use the brief's outdated IDs" — and a
-- live OpenRouter catalog check at implementation time
-- (curl https://openrouter.ai/api/v1/models) confirmed 'anthropic/claude-sonnet-5'
-- exists there too. Using that as the default instead, per both the repo's
-- own model convention and the design spec's instruction to correct the
-- default against the live catalog at implementation time.
alter table app_settings
  add column if not exists stats_chat_model text not null default 'anthropic/claude-sonnet-5';

comment on column app_settings.stats_chat_model is
  'OpenRouter model slug used by the Statistics page LLM chat (app/api/stats/chat/route.ts). Editable from Settings.';
