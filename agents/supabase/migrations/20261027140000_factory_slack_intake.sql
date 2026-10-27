-- Garden only (side project, GARDEN_SUPABASE_URL). Slack intake: ops messages
-- in #cx-desk become alerts (agents/factory/slack-intake*.mjs). Builds on
-- agents/factory/schema.sql and 20261027120000_factory_rule_cards.sql, which
-- defines factory_alerts: the intake writes there with source 'slack', and the
-- sweep opens, closes and reopens the rule's card by CARD_LIFE
-- (agents/factory/general-rules.mjs). Not applied yet: run it on the garden
-- after those. Idempotent.

-- slack_intake: one row per ops message handled, and the one question we asked.
create table if not exists slack_intake (
  channel text not null,
  ts text not null,
  user_id text,
  text text,
  order_name text,
  state text not null check (state in ('asked', 'alert', 'judgement', 'passed')),
  -- {about: 'order' | 'rule', choices: [rule ids]} while state = 'asked'.
  question jsonb,
  rule_id text,
  why text,
  -- Our reply in the thread: answers are the replies after it.
  reply_ts text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (channel, ts)
);
create index if not exists slack_intake_asked_idx on slack_intake (channel) where state = 'asked';

-- Where each reader stopped (docs/agent-factory/human-loop.md, "a bookmark per source").
create table if not exists factory_bookmarks (
  source text primary key,
  position text not null,
  updated_at timestamptz not null default now()
);

-- Service role only: no policies, so anon and signed-in users read nothing.
alter table slack_intake enable row level security;
alter table factory_bookmarks enable row level security;
