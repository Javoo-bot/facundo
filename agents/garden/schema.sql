-- The garden's scorecard. Garden database only (side project your-project-ref);
-- production never runs this file, which is why it is not in supabase/migrations.
--
-- garden_scenarios: one row per invented order, written by the weather when it
-- plants the order. It says which /lifecycle branch the order carries and what
-- the loop should end up doing with it.
-- garden_scores: one row per scenario per scoring day, written by the daily
-- score. It says what actually happened and whether that matched.
--
-- Idempotent: safe to run again.

create table if not exists garden_scenarios (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  -- Shopify order id the weather posted, e.g. GARDEN-2026-10-13-07.
  shopify_order_id text not null unique,
  order_id uuid references orders(id) on delete set null,
  -- Stage and branch ids from dashboard/lib/lifecycle.ts; branch_id null = happy path.
  stage_id text not null,
  branch_id text,
  title text not null,
  -- What the loop should reach on its own, e.g. 'paid', 'escalated', 'held'.
  expected_outcome text not null,
  -- Extra checks the score reads, e.g. {"max_minutes": 120, "attention_label": "..."}.
  expected jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists garden_scenarios_day_idx on garden_scenarios (day);

create table if not exists garden_scores (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references garden_scenarios(id) on delete cascade,
  scored_on date not null,
  actual_outcome text,
  passed boolean not null,
  -- Why it failed, or what the loop did instead, in plain words.
  notes text,
  detail jsonb not null default '{}'::jsonb,
  scored_at timestamptz not null default now(),
  unique (scenario_id, scored_on)
);

-- Service role only: no policies, so anon and signed-in users read nothing.
alter table garden_scenarios enable row level security;
alter table garden_scores enable row level security;
