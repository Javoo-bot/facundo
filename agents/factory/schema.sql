-- The factory's work queue. Garden database only (side project your-project-ref);
-- production never runs this file, which is why it is not in supabase/migrations.
--
-- factory_tasks: one card = one problem for exactly one agent (an id from
-- agents/thinking/*.md). Written by agents/factory/sweep-signals.mjs from garden
-- signals; the fingerprint names the problem, e.g.
-- "concierge:conversation_escalation:no-order".
-- factory_runs: one row per attempt at a card by a factory worker.
--
-- Idempotent: safe to run again.

create table if not exists factory_tasks (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  title text not null,
  -- What is wrong, in plain words, for the owner and the team.
  summary text not null,
  -- {count, examples: [...], ...}: what the sweep saw, refreshed on every sweep.
  evidence jsonb not null default '{}'::jsonb,
  -- conversation_escalation | stuck_order | photo_review | garden_score |
  -- below_minimum (a deep-analysis card, docs/agent-factory/agent-minimums.md) |
  -- human (a card the owner asked for directly)
  source text not null,
  status text not null default 'open',
  fingerprint text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Newest timestamp among the signal rows behind this card: how old the data is.
  latest_signal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Kept equal to the files in agents/thinking/ by agents/factory/cards.test.mjs.
alter table factory_tasks drop constraint if exists factory_tasks_agent_check;
alter table factory_tasks add constraint factory_tasks_agent_check check (agent in (
  'babel', 'bloom', 'concierge', 'cupid', 'hawkeye', 'oracle', 'polyglot', 'quill', 'scout', 'sherlock'
));
alter table factory_tasks drop constraint if exists factory_tasks_status_check;
alter table factory_tasks add constraint factory_tasks_status_check
  check (status in ('open', 'in-progress', 'done', 'dropped'));
alter table factory_tasks drop constraint if exists factory_tasks_source_check;
alter table factory_tasks add constraint factory_tasks_source_check
  check (source in ('conversation_escalation', 'stuck_order', 'photo_review', 'garden_score', 'below_minimum', 'human'));

-- The same signal never makes two live cards. A done or dropped card frees the
-- fingerprint, so a problem that comes back after a fix gets a fresh card.
create unique index if not exists factory_tasks_live_fingerprint
  on factory_tasks (fingerprint) where status in ('open', 'in-progress');
create index if not exists factory_tasks_status_idx on factory_tasks (status);

create table if not exists factory_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references factory_tasks(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- null while running.
  outcome text check (outcome in ('fixed', 'failed', 'gave-up', 'needs-human')),
  branch text,
  pr_url text,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists factory_runs_task_idx on factory_runs (task_id);

-- Service role only: no policies, so anon and signed-in users read nothing.
alter table factory_tasks enable row level security;
alter table factory_runs enable row level security;
