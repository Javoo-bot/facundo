-- Garden only (side project, GARDEN_SUPABASE_URL). Cards per general rule and a
-- card's life (docs/agent-factory/garden-1.2/README.md sections 1-3; the pure
-- rules are agents/factory/general-rules.mjs). Builds on agents/factory/schema.sql.
-- Not applied yet: run it on the garden after schema.sql. Idempotent.
--
-- A card opens on a general rule at 3 alerts in 7 days, closes once the rule
-- has been quiet 7 days after the fix merged, and a new alert on a closed rule
-- reopens the SAME card (the owner, 2026-10-27).

alter table factory_tasks add column if not exists general_rule text;
alter table factory_tasks add column if not exists manager text;
-- Set by agents/factory/after-merge.mjs (or the free lane) when the card's PR merges.
alter table factory_tasks add column if not exists merged_at timestamptz;
alter table factory_tasks add column if not exists closed_at timestamptz;
alter table factory_tasks add column if not exists reopened_at timestamptz;
alter table factory_tasks add column if not exists reopened_count integer not null default 0;

alter table factory_tasks drop constraint if exists factory_tasks_manager_check;
alter table factory_tasks add constraint factory_tasks_manager_check
  check (manager is null or manager in ('harvey', 'donna', 'louis', 'jessica'));

-- rule: one card per general rule (source of the four per-signal sources the
-- sweep no longer writes; they stay allowed for the cards already there).
alter table factory_tasks drop constraint if exists factory_tasks_source_check;
alter table factory_tasks add constraint factory_tasks_source_check
  check (source in ('conversation_escalation', 'stuck_order', 'photo_review', 'garden_score', 'below_minimum', 'human', 'cluster', 'factory', 'error', 'rule'));

-- One card per general rule, ever: a comeback reopens it instead of a new one.
create unique index if not exists factory_tasks_one_card_per_rule
  on factory_tasks (general_rule) where source = 'rule';

-- Every alert the sweep saw, placed once on a general rule (or on none).
create table if not exists factory_alerts (
  -- source:ref-id:key, e.g. "stuck_order:<order uuid>:offer-stalling".
  alert_id text primary key,
  source text not null,
  key text not null,
  label text,
  ref jsonb not null default '{}'::jsonb,
  -- null when no rule fits (match 'none'): listed by the sweep, never dropped.
  rule_id text,
  match text not null check (match in ('exact', 'near', 'none')),
  why text,
  -- What the near match cost on OpenRouter; 0 for exact matches.
  cost_usd numeric not null default 0,
  placed_at timestamptz not null default now(),
  -- Madrid day of placed_at: the near-match cap ($0.50) is per day.
  placed_day date not null
);
-- The latest sweep that still saw it: a problem still there (the same stuck
-- order every sweep) keeps its rule from going quiet, and reopens a closed card.
alter table factory_alerts add column if not exists last_seen_at timestamptz;
create index if not exists factory_alerts_rule_idx on factory_alerts (rule_id, placed_at);
create index if not exists factory_alerts_seen_idx on factory_alerts (rule_id, last_seen_at);
create index if not exists factory_alerts_day_idx on factory_alerts (placed_day);

-- Service role only, like factory_tasks.
alter table factory_alerts enable row level security;

-- Every near-match call, answered or failed: the $0.50 Madrid-day cap sums
-- this, so a call that failed after it was billed still counts.
create table if not exists factory_near_calls (
  id bigint generated always as identity primary key,
  alert_id text not null,
  cost_usd numeric not null,
  ok boolean not null,
  called_at timestamptz not null default now(),
  -- Madrid day of called_at.
  day date not null
);
create index if not exists factory_near_calls_day_idx on factory_near_calls (day);
alter table factory_near_calls enable row level security;
