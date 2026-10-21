-- Every answer the garden operator gives through the "Garden operator" connector.
-- Garden database only (side project your-project-ref); production never runs
-- this file, which is why it is not in supabase/migrations.
--
-- One row per decision: which agent stopped and why, what it drafted, what the
-- operator chose and what was finally sent. Pairs of agent_draft and final_text
-- are the examples of a good answer for each agent.
--
-- Idempotent: safe to run again.

create table if not exists operator_decisions (
  id uuid primary key default gen_random_uuid(),
  -- The id the operator saw: 'c-<conversation id>' or 'a-<approval id>'.
  decision_ref text not null,
  source text not null check (source in ('conversation', 'approval')),
  source_id uuid not null,
  order_id uuid references orders(id) on delete set null,
  -- concierge (support), cupid (recruiting), or step:<approval kind>.
  agent text,
  why_stopped text,
  action text not null check (action in ('approve_draft', 'send_my_reply', 'reject', 'escalate_to_owner')),
  agent_draft text,
  final_text text,
  note text,
  -- The person, as they named themselves when connecting.
  operator text not null,
  -- The garden staff account the dashboard saw press the button.
  acted_as text,
  -- The agent's prompt and facts at the time of the draft (conversation_messages.ai_context).
  ai_context jsonb,
  decided_at timestamptz not null default now()
);
create index if not exists operator_decisions_source_idx on operator_decisions (source_id);
create index if not exists operator_decisions_decided_idx on operator_decisions (decided_at desc);

-- Service role only: no policies, so anon and signed-in users read nothing.
alter table operator_decisions enable row level security;
