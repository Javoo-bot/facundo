-- Garden only (side project, GARDEN_SUPABASE_URL). When the agent is not sure,
-- it asks the owner and waits (agents/factory/questions.mjs). Builds on
-- agents/factory/schema.sql and 20261027120000_factory_rule_cards.sql.
-- Not applied yet: run it on the garden after both. Idempotent.

-- waiting_for_answer: the agent was not sure and asked the owner (question below);
-- the executor skips it until the sweep reads his answer and sets it open.
alter table factory_tasks drop constraint if exists factory_tasks_status_check;
alter table factory_tasks add constraint factory_tasks_status_check
  check (status in ('open', 'in-progress', 'done', 'dropped', 'parked', 'waiting_for_answer'));

-- {text, choices: [{letter, text}], round, asked_at, run_id, pr_url, issue_url}:
-- the newest question an agent asked on this card. Kept after the answer, so the
-- next brief can quote it.
alter table factory_tasks add column if not exists question jsonb;
-- {letter, choice, note, by, at, url, round}: the owner's reply to that question,
-- read from a comment on its PR or issue ("answer: B").
alter table factory_tasks add column if not exists answer jsonb;

-- A card waiting for an answer is live: the sweep refreshes it, never
-- duplicates it.
drop index if exists factory_tasks_live_fingerprint;
create unique index factory_tasks_live_fingerprint
  on factory_tasks (fingerprint) where status in ('open', 'in-progress', 'waiting_for_answer');

-- question: the agent was not sure and asked the owner; the card waits for him.
alter table factory_runs drop constraint if exists factory_runs_outcome_check;
alter table factory_runs add constraint factory_runs_outcome_check
  check (outcome in ('fixed', 'failed', 'gave-up', 'needs-human', 'question'));
