-- The owner's decisions of 2026-10-15 for the garden's Planner and factory.
-- Garden only in practice: production gets a wider check on an empty table
-- and a view over agent_events, which only the garden writes.

-- Ideas can name the Planner (agents/thinking/planner.md), which Phase 4 added
-- to the registry. Kept equal to agents/thinking by agents/factory/cards.test.mjs.
alter table garden_ideas drop constraint if exists garden_ideas_agent_check;
alter table garden_ideas add constraint garden_ideas_agent_check check (agent in (
  'babel', 'bloom', 'concierge', 'cupid', 'hawkeye', 'oracle', 'planner', 'polyglot', 'quill', 'scout', 'sherlock'
));

-- The denominator of the cluster rule (agents/factory/cluster-rule.mjs): every
-- case the agents handled on a Madrid day. A rule-gap cluster's daily rate is
-- its cases that day over this.
create or replace view agent_cases_daily as
  select ((created_at at time zone 'Europe/Madrid')::date)::text as day,
         count(distinct case_id)::int as cases
  from agent_events
  group by 1;

revoke all on agent_cases_daily from anon, authenticated;
grant select on agent_cases_daily to service_role;
