-- The garden's monitoring: one place that says, per agent and per day, how each
-- "What good looks like" measure in agents/thinking/<id>.md is doing against
-- its minimum. Garden database only (side project your-project-ref);
-- production never runs this file, which is why it is not in supabase/migrations.
--
--   agent_minimums        the measures and minimums, written by
--                         agents/monitoring/minimums.mjs from the agent files.
--                         Never edited by hand.
--   agent_trace_runs      the Langfuse runs a few measures need (Babel, Bloom,
--                         Oracle, Polyglot), copied in by agents/monitoring/collect.mjs.
--   agent_tone_scores     the daily tone check's scores (agents/garden/tone/),
--                         stored by agents/monitoring/store-tone.mjs.
--   agent_measure_cases   one row per case a measure judged: passed or not, with
--                         links to the case. The single place the measures are computed.
--   agent_measure_daily   the cases counted per agent, measure and day.
--   agent_daily_metrics   each measure on each of the last 30 days, over its own
--                         window, against its minimum. Grafana and the factory
--                         sweep both read this.
--   garden_* / factory_cards   what the overview dashboard shows.
--
-- Days are Madrid days. Idempotent: safe to run again. Apply with
-- `node agents/monitoring/apply.mjs`.

create or replace function monitoring_day(ts timestamptz) returns date
  language sql immutable parallel safe
  as $$ select (ts at time zone 'Europe/Madrid')::date $$;

-- The garden began on 2026-10-13. Older rows came over with the staging copy
-- (old recruiting threads, August approvals): The owner asked to leave them out.
create or replace function garden_epoch() returns timestamptz
  language sql immutable parallel safe
  as $$ select timestamptz '2026-10-13 00:00 Europe/Madrid' $$;

create table if not exists agent_minimums (
  agent text not null,
  measure text not null,
  nick text not null,
  position int not null,
  means text not null,
  data text not null,
  kind text not null check (kind in ('decides', 'advice')),
  op text not null check (op in ('>=', '<=')),
  minimum numeric not null,
  percent boolean not null,
  minimum_text text not null,
  window_days int not null check (window_days > 0),
  min_cases int not null check (min_cases >= 0),
  window_text text not null,
  measurable_now boolean not null,
  measurable text not null,
  updated_at timestamptz not null default now(),
  primary key (agent, measure)
);

create table if not exists agent_trace_runs (
  trace_id text primary key,
  agent text not null,
  name text not null,
  started_at timestamptz not null,
  level text,
  session_id text,
  -- md5 of the prompt, to find the rows the run wrote (Babel's translations).
  input_md5 text,
  output text,
  metadata jsonb not null default '{}'::jsonb,
  -- Polyglot only: the reply judged again, [{locale, ok, reasons}].
  replay jsonb,
  fetched_at timestamptz not null default now()
);
create index if not exists agent_trace_runs_name_idx on agent_trace_runs (name, started_at);

create table if not exists agent_tone_scores (
  message_id uuid primary key references conversation_messages(id) on delete cascade,
  score numeric,
  reason text,
  model text,
  scored_at timestamptz not null default now()
);

-- Service role and Grafana only: no policies, so anon and signed-in users read nothing.
alter table agent_minimums enable row level security;
alter table agent_trace_runs enable row level security;
alter table agent_tone_scores enable row level security;

create or replace function quill_draft_part(draft text, part int) returns text
  language sql immutable parallel safe as $$
  -- Mirrors parseDraft in dashboard/lib/outreach.ts: part 1 subject, 2 body.
  select case
    when draft is null then case part when 1 then 'Partnering with Facundo' else '' end
    when m is null then case part when 1 then 'Partnering with Facundo' else btrim(draft, E' \t\r\n') end
    else btrim(m[part], E' \t\r\n') end
  from (select regexp_match(draft, E'^\\s*Subject:\\s*([^\\r\\n]+?)\\r?\\n(?:\\r?\\n)?(.*)$') m) x
$$;

-- Drop dependants first so a column change below never trips "cannot change view".
drop view if exists agent_daily_metrics;
drop view if exists agent_measure_daily;
drop view if exists agent_measure_cases;
drop view if exists garden_order_results;
drop view if exists garden_open_decisions;
drop view if exists garden_conversation_escalations;
drop view if exists garden_order_issues;
drop view if exists factory_cards;

create view agent_measure_cases as
with
  dash as (select 'https://facundo-dashboard-garden.your-subdomain.workers.dev' as url),
  lf as (select 'https://cloud.langfuse.com/project/<your-langfuse-project-id>' as url),

  -- Concierge and Cupid: an AI draft held for a person, and the next reply a
  -- person sent in that thread with no newer draft in between.
  stopped_drafts as (
    select d.id, d.created_at, d.body_text, c.id as conversation_id, c.kind, c.order_id, c.florist_id,
           r.id as reply_id, r.created_at as reply_at, r.body_text as reply_text, r.actor
    from conversation_messages d
    join conversations c on c.id = d.conversation_id
    join lateral (
      select r.* from conversation_messages r
      where r.conversation_id = d.conversation_id and r.direction = 'out'
        and not coalesce(r.ai_generated, false) and r.created_at > d.created_at
      order by r.created_at limit 1
    ) r on true
    where d.ai_generated and d.direction = 'out' and d.status = 'draft'
      and c.kind in ('support', 'recruiting')
      and not exists (
        select 1 from conversation_messages x
        where x.conversation_id = d.conversation_id and x.ai_generated and x.status = 'draft'
          and x.created_at > d.created_at and x.created_at < r.created_at)
  ),
  agreement as (
    select case kind when 'support' then 'concierge' else 'cupid' end as agent,
           'operator-agreement' as measure,
           'conversation_messages:' || id as case_ref,
           reply_at as at,
           btrim(coalesce(body_text, ''), E' \t\r\n') = btrim(coalesce(reply_text, ''), E' \t\r\n') as passed,
           null::numeric as score,
           case when btrim(coalesce(body_text, ''), E' \t\r\n') = btrim(coalesce(reply_text, ''), E' \t\r\n')
                then 'The person sent the AI draft as written'
                else 'The person changed the AI draft before sending' end as summary,
           (select url from dash) || case when order_id is not null then '/orders/' || order_id
                                         when florist_id is not null then '/florists/' || florist_id
                                         else '/conversations' end as link,
           (select url from lf) || '/sessions/' || conversation_id as trace_link,
           'conversation_messages.ai_context id=' || id as context_ref
    from stopped_drafts
  ),

  handover as (
    select 'cupid' as agent, 'money-and-contract-handover' as measure,
           'conversation_messages:' || m.id as case_ref, m.created_at as at,
           m.status = 'draft' as passed, null::numeric as score,
           case when m.status = 'draft' then 'A money or contract question went to a person'
                else 'A money or contract question was answered without a person (' || m.status || ')' end as summary,
           (select url from dash) || coalesce('/florists/' || c.florist_id, '/conversations') as link,
           (select url from lf) || '/sessions/' || c.id as trace_link,
           'conversation_messages.ai_context id=' || m.id as context_ref
    from conversation_messages m join conversations c on c.id = m.conversation_id
    where c.kind = 'recruiting' and m.ai_generated and m.direction = 'out'
      and m.ai_intent in ('question_pricing', 'question_legal')
  ),

  -- Hawkeye in the garden: the latest photo check on each planted order.
  planted as (
    select s.id as scenario_id, s.shopify_order_id, s.order_id, s.expected,
           pv.id as pv_id, pv.verdict, pv.confidence, pv.created_at
    from garden_scenarios s
    join lateral (
      select * from photo_verifications p where p.order_id = s.order_id order by p.created_at desc limit 1
    ) pv on true
    where s.order_id is not null
  ),
  photos as (
    select 'hawkeye' as agent, 'planted-bad-photo-caught' as measure,
           'photo_verifications:' || pv_id as case_ref, created_at as at,
           coalesce(expected->'photo_verdict' ? verdict, false) as passed, null::numeric as score,
           shopify_order_id || ': a wrong photo got ' || verdict || ' (expected ' || (expected->>'photo_verdict') || ')' as summary,
           (select url from dash) || '/orders/' || order_id as link,
           null::text as trace_link,
           'photo_verifications.ai_context id=' || pv_id as context_ref
    from planted where expected ? 'photo_verdict'
    union all
    select 'hawkeye', 'planted-good-photo-passed',
           'photo_verifications:' || pv_id, created_at,
           verdict = 'pass', null::numeric,
           shopify_order_id || ': the real bouquet photo got ' || verdict || ' (confidence ' || coalesce(round(confidence, 2)::text, '?') || ')',
           (select url from dash) || '/orders/' || order_id,
           null::text,
           'photo_verifications.ai_context id=' || pv_id
    from planted
    where expected->'steps' @> '[{"photo": "bouquet"}]' and not expected ? 'photo_verdict'
  ),

  -- Quill: emails sent, against the florist's stored draft.
  quill as (
    select 'quill' as agent, 'sent-unchanged' as measure,
           'outreach:' || o.id as case_ref, o.sent_at as at,
           btrim(coalesce(o.subject, ''), E' \t\r\n') = quill_draft_part(f.drafted_email, 1)
             and btrim(coalesce(o.body, ''), E' \t\r\n') = quill_draft_part(f.drafted_email, 2) as passed,
           null::numeric as score,
           coalesce(f.name, 'A shop') || case when btrim(coalesce(o.body, ''), E' \t\r\n') = quill_draft_part(f.drafted_email, 2)
             and btrim(coalesce(o.subject, ''), E' \t\r\n') = quill_draft_part(f.drafted_email, 1)
             then ': sent as Quill wrote it' else ': edited before sending' end as summary,
           (select url from dash) || '/florists/' || f.id as link,
           null::text as trace_link,
           'florists.drafted_email_context id=' || f.id as context_ref
    from outreach o join florists f on f.id = o.florist_id
    where o.channel = 'email' and o.status = 'sent' and o.sent_at is not null
      and f.drafted_email_context->>'personalised' = 'true'
    union all
    select 'quill', 'personalised',
           'outreach:' || o.id, o.sent_at,
           (f.drafted_email_context->>'personalised')::boolean, null::numeric,
           coalesce(f.name, 'A shop') || case when (f.drafted_email_context->>'personalised')::boolean
             then ': got a personal email' else ': got the plain catalog email' end,
           (select url from dash) || '/florists/' || f.id,
           null::text,
           'florists.drafted_email_context id=' || f.id
    from outreach o join florists f on f.id = o.florist_id
    where o.channel = 'email' and o.status = 'sent' and o.sent_at is not null
      and f.drafted_email_context ? 'personalised'
      and jsonb_typeof(f.drafted_email_context->'personalised') = 'boolean'
  ),

  -- Scout: country names normalised as normalizeCountry in ingest-worker/src/keywords.ts.
  jobs as (
    select j.*, case when length(btrim(j.country)) <= 3 then upper(btrim(j.country))
                     else initcap(lower(btrim(j.country))) end as country_key
    from ingest_jobs j where j.country is not null
  ),
  scout as (
    select 'scout' as agent, 'words-written' as measure,
           'ingest_jobs:' || j.id as case_ref, j.started_at as at,
           exists (select 1 from country_keywords k where k.country = j.country_key) as passed,
           null::numeric as score,
           j.country_key || coalesce(' / ' || j.city, '') ||
             case when exists (select 1 from country_keywords k where k.country = j.country_key)
                  then ': search words were there' else ': no search words for this country' end as summary,
           (select url from dash) || '/jobs' as link,
           null::text as trace_link,
           'country_keywords.ai_context country=' || j.country_key as context_ref
    from jobs j where j.started_at is not null
    union all
    select 'scout', 'first-city-finds-florists',
           'country_keywords:' || k.country, first_job.finished_at,
           coalesce(first_job.florist_count, 0) >= 10, null::numeric,
           k.country || ': the first city (' || coalesce(first_job.city, '?') || ') kept ' || coalesce(first_job.florist_count, 0) || ' florists',
           (select url from dash) || '/jobs',
           null::text,
           'country_keywords.ai_context country=' || k.country
    from country_keywords k
    join lateral (
      select * from jobs j where j.country_key = k.country and j.status = 'succeeded'
      order by j.started_at limit 1
    ) first_job on true
    where k.ai_context is not null and first_job.finished_at is not null
  ),

  sherlock as (
    select 'sherlock' as agent, 'contact-found' as measure,
           'florists:' || f.id as case_ref, f.ingested_at as at,
           (f.email is not null or f.phone_web is not null) as passed, null::numeric as score,
           coalesce(f.name, 'A shop') || case when f.email is not null or f.phone_web is not null
             then ': found a contact on the website' else ': no email or phone found on the website' end as summary,
           (select url from dash) || '/florists/' || f.id as link,
           null::text as trace_link,
           'florists.enrichment_ai_context id=' || f.id as context_ref
    from florists f
    -- A florist only becomes a Sherlock case once Sherlock actually read its
    -- site: enrichment_ai_context set (an LLM call happened) OR real notes
    -- from a crawl attempt (enrich.ts always writes notes, even when nothing
    -- was found or the LLM leg failed — see repair.ts::REPAIR_FAILURE_PATTERNS
    -- for that vocabulary). The free-place-layer import (Overture Maps,
    -- docs/agent-factory/tasks/002-free-florist-layer.md) seeds rows with
    -- website_url set but enrichment_notes = "Unchecked ..." — a non-null
    -- placeholder, not a crawl result — so it must be excluded explicitly or
    -- every un-enriched free-layer shop counts as a Sherlock miss.
    where f.has_website and f.ingested_at is not null
      and (f.enrichment_ai_context is not null
           or (f.enrichment_notes is not null and f.enrichment_notes not ilike 'unchecked%'))
    union all
    select 'sherlock', 'email-delivers',
           'outreach:' || o.id, o.sent_at,
           f.email_bounced_at is null, null::numeric,
           coalesce(f.name, 'A shop') || case when f.email_bounced_at is null then ': email delivered' else ': email bounced' end,
           (select url from dash) || '/florists/' || f.id,
           null::text,
           'florists.enrichment_ai_context id=' || f.id
    from outreach o join florists f on f.id = o.florist_id
    where o.channel = 'email' and o.status = 'sent' and not o.test_mode and o.sent_at is not null
  ),

  -- Langfuse-only measures (Babel, Bloom, Oracle, Polyglot), from the copied runs.
  babel_runs as (
    select t.*, greatest(coalesce((t.metadata->>'strings')::int, 1), 1) as asked,
           (select count(*) from content_translations ct
             where ct.provider = 'llm' and md5(ct.ai_context->>'prompt') = t.input_md5) as written
    -- Only runs from the real call site (lib/translations/lineItems.ts), which
    -- says how many texts it asked for; a hand-made probe does not.
    from agent_trace_runs t where t.name = 'babel.run' and t.metadata ? 'strings'
  ),
  traces as (
    select 'babel' as agent, 'translations-pass-check' as measure,
           'langfuse:' || b.trace_id || '#' || i as case_ref, b.started_at as at,
           i <= least(b.written, b.asked) as passed, null::numeric as score,
           'Text ' || i || ' of ' || b.asked || case when i <= least(b.written, b.asked)
             then ' reached the florist translated' else ' stayed in English' end as summary,
           null::text as link,
           (select url from lf) || '/traces/' || b.trace_id as trace_link,
           'content_translations.ai_context (prompt of trace ' || b.trace_id || ')' as context_ref
    from babel_runs b cross join generate_series(1, b.asked) i
    union all
    select 'bloom', 'calls-answered',
           'langfuse:' || t.trace_id, t.started_at,
           coalesce(t.level, '') <> 'ERROR', null::numeric,
           case when coalesce(t.level, '') <> 'ERROR' then 'Bloom answered' else 'Bloom''s call failed' end,
           null::text, (select url from lf) || '/traces/' || t.trace_id, 'Langfuse trace only'
    from agent_trace_runs t where t.name = 'bloom.run'
    union all
    select 'oracle', 'answers-finish',
           'langfuse:' || t.trace_id, t.started_at,
           coalesce(t.level, '') <> 'ERROR' and coalesce(t.output, '') not like 'I wasn''t able to finish answering that%',
           null::numeric,
           case when coalesce(t.level, '') = 'ERROR' then 'Oracle failed with an error'
                when coalesce(t.output, '') like 'I wasn''t able to finish answering that%' then 'Oracle gave up after 5 rounds'
                else 'Oracle answered' end,
           null::text, (select url from lf) || '/traces/' || t.trace_id, 'Langfuse trace only'
    from agent_trace_runs t where t.name = 'oracle.run'
    union all
    select 'polyglot', 'drafts-pass-check',
           'langfuse:' || t.trace_id || '#' || (v->>'locale'), t.started_at,
           (v->>'ok')::boolean, null::numeric,
           'Locale ' || (v->>'locale') || case when (v->>'ok')::boolean then ' passed the check'
             else ' failed the check: ' || coalesce(v->>'reasons', '?') end,
           (select url from dash) || '/messages',
           (select url from lf) || '/traces/' || t.trace_id,
           'message_override_drafts.ai_context key=' || coalesce(t.metadata->>'key', '?')
    from agent_trace_runs t cross join jsonb_array_elements(coalesce(t.replay, '[]'::jsonb)) v
    where t.name = 'polyglot.run'
  ),

  tone as (
    select case c.kind when 'support' then 'concierge' else 'cupid' end as agent, 'tone' as measure,
           'conversation_messages:' || m.id as case_ref, m.created_at as at,
           s.score >= 0.7 as passed, s.score,
           'Tone ' || round(s.score, 1) || ': ' || coalesce(s.reason, '') as summary,
           (select url from dash) || case when c.order_id is not null then '/orders/' || c.order_id
                                         when c.florist_id is not null then '/florists/' || c.florist_id
                                         else '/conversations' end as link,
           (select url from lf) || '/sessions/' || c.id as trace_link,
           'conversation_messages.ai_context id=' || m.id as context_ref
    from agent_tone_scores s
    join conversation_messages m on m.id = s.message_id
    join conversations c on c.id = m.conversation_id
    where s.score is not null and c.kind in ('support', 'recruiting')
  ),

  all_cases as (
    select * from agreement union all select * from handover union all select * from photos
    union all select * from quill union all select * from scout union all select * from sherlock
    union all select * from traces union all select * from tone
  )
select agent, measure, case_ref, at, monitoring_day(at) as day, passed,
       coalesce(score, case when passed then 1 else 0 end)::numeric as score,
       summary, link, trace_link, context_ref
from all_cases;

create view agent_measure_daily as
select agent, measure, day, count(*)::int as cases, (count(*) filter (where passed))::int as matching,
       sum(score) as score_sum
from agent_measure_cases
group by agent, measure, day;

-- Each measure on each of the last 30 days, judged over its own window ending
-- that day, exactly as agents/factory/thresholds.mjs::windowOn does.
create view agent_daily_metrics as
with
  days as (
    select generate_series(monitoring_day(now()) - 29, monitoring_day(now()), interval '1 day')::date as day
  ),
  daily as materialized (
    select * from agent_measure_daily where day >= monitoring_day(now()) - 60
  ),
  windows as (
    select d.day, m.agent, m.measure,
           coalesce(sum(x.cases), 0)::int as cases,
           coalesce(sum(x.matching), 0)::int as matching,
           sum(x.score_sum) as score_sum
    from days d
    cross join agent_minimums m
    left join daily x on x.agent = m.agent and x.measure = m.measure
      and x.day between d.day - (m.window_days - 1) and d.day
    group by d.day, m.agent, m.measure
  ),
  judged as (
    select w.*, m.nick, m.position, m.kind, m.op, m.minimum, m.percent, m.minimum_text, m.window_days,
           m.min_cases, m.window_text, m.measurable_now, m.measurable, m.means,
           case when not m.measurable_now or w.cases = 0 then null
                when m.percent then w.matching::numeric / w.cases
                else w.score_sum / w.cases end as value
    from windows w join agent_minimums m using (agent, measure)
  )
select day, agent, nick, measure, position, means, kind, kind = 'decides' as decides,
       cases, matching, round(value, 4) as value, minimum, op, percent, minimum_text,
       window_days, min_cases, window_text, measurable_now,
       measurable_now and cases >= min_cases as judged,
       measurable_now and cases >= min_cases and value is not null
         and (case op when '>=' then value < minimum else value > minimum end) as below,
       case
         when not measurable_now then 'not measurable yet'
         when cases < min_cases then 'not enough cases'
         when (case op when '>=' then value < minimum else value > minimum end) then 'below minimum'
         else 'ok' end as status,
       case
         when not measurable_now then regexp_replace(measurable, '^not measurable yet: ', '')
         when cases < min_cases then cases || ' of the ' || min_cases || ' cases needed in the window (' || window_text || ')'
         else null end as reason
from judged;

-- Overview: the invented orders and how they ended.
create view garden_order_results as
select s.day, s.shopify_order_id, s.title, s.stage_id, coalesce(s.branch_id, 'happy path') as branch,
       s.expected_outcome, g.actual_outcome,
       case when g.passed is null then 'not scored yet' when g.passed then 'passed' else 'failed' end as result,
       g.notes, g.scored_at, o.status as order_status,
       'https://facundo-dashboard-garden.your-subdomain.workers.dev/orders/' || s.order_id as link
from garden_scenarios s
left join lateral (
  select * from garden_scores x where x.scenario_id = s.id order by x.scored_on desc, x.scored_at desc limit 1
) g on true
left join orders o on o.id = s.order_id;

-- Overview: what is waiting on the garden operator right now.
create view garden_open_decisions as
select 'conversation' as source, c.id, case c.kind when 'support' then 'concierge' when 'recruiting' then 'cupid' else c.kind end as agent,
       coalesce(c.escalation_reason, 'unknown') as reason, coalesce(c.escalated_at, c.updated_at) as since,
       'https://facundo-dashboard-garden.your-subdomain.workers.dev' ||
         case when c.order_id is not null then '/orders/' || c.order_id
              when c.florist_id is not null then '/florists/' || c.florist_id else '/conversations' end as link
from conversations c where c.status = 'awaiting_human' and coalesce(c.escalated_at, c.updated_at) >= garden_epoch()
union all
select 'approval', a.id, 'step:' || a.kind, coalesce(a.reason, a.kind), a.created_at,
       'https://facundo-dashboard-garden.your-subdomain.workers.dev/orders/' || a.order_id
from order_approvals a where a.status = 'pending' and a.created_at >= garden_epoch();

-- Overview: conversations handed to a person, per day and reason.
create view garden_conversation_escalations as
select monitoring_day(c.escalated_at) as day, c.kind, coalesce(c.escalation_reason, 'unknown') as reason, count(*)::int as conversations
from conversations c where c.escalated_at >= garden_epoch()
group by 1, 2, 3;

-- Overview: orders that need a person, by what is wrong.
-- Statuses as IN_FULFILMENT in dashboard/lib/cxAttentionRules.ts.
create view garden_order_issues as
select * from (
  select o.id, o.order_name, o.shopify_order_id, o.status,
         case when o.status = 'escalated' then 'Handed to a person: ' || coalesce(o.escalation_reason, 'no reason given')
              when o.delivery_at < now() and o.status in ('accepted', 'in_production', 'ready', 'out_for_delivery') then 'Late: past the delivery time, not delivered'
              when o.delivery_at < now() and o.status = 'reaching_out' then 'Late: past the delivery time, no florist yet'
         end as issue,
         o.delivery_at, o.created_at,
         'https://facundo-dashboard-garden.your-subdomain.workers.dev/orders/' || o.id as link
  from orders o
  where o.deleted_at is null and not coalesce(o.is_demo, false) and o.created_at > greatest(now() - interval '14 days', garden_epoch())
) x where issue is not null;

-- Overview: factory cards with their newest run.
create view factory_cards as
select t.id, t.agent, t.title, t.status, t.source, t.fingerprint, t.first_seen_at, t.last_seen_at,
       (t.evidence->>'count')::int as signals, r.outcome as last_outcome, r.pr_url, r.finished_at as last_run_at
from factory_tasks t
left join lateral (
  select * from factory_runs x where x.task_id = t.id order by x.started_at desc limit 1
) r on true;

-- Nobody but the service role and Grafana's read-only role reads any of this:
-- the views run as their owner, so anon must not be able to select them.
do $$
declare v text;
begin
  foreach v in array array['agent_measure_cases', 'agent_measure_daily', 'agent_daily_metrics', 'garden_order_results',
                           'garden_open_decisions', 'garden_conversation_escalations', 'garden_order_issues', 'factory_cards',
                           'agent_minimums', 'agent_trace_runs', 'agent_tone_scores'] loop
    execute format('revoke all on %I from anon, authenticated', v);
    execute format('grant select on %I to service_role', v);
  end loop;
  grant insert, update, delete on agent_minimums, agent_trace_runs, agent_tone_scores to service_role;
  if exists (select 1 from pg_roles where rolname = 'grafana_ro') then
    foreach v in array array['agent_measure_cases', 'agent_measure_daily', 'agent_daily_metrics', 'garden_order_results',
                             'garden_open_decisions', 'garden_conversation_escalations', 'garden_order_issues', 'factory_cards',
                             'agent_minimums'] loop
      execute format('grant select on %I to grafana_ro', v);
    end loop;
    -- agent_minimums is a table under RLS (the views run as their owner and need no policy).
    drop policy if exists agent_minimums_grafana_read on agent_minimums;
    create policy agent_minimums_grafana_read on agent_minimums for select to grafana_ro using (true);
  end if;
end $$;
