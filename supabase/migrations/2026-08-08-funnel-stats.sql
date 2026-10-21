-- Outreach funnel numbers for /statistics.
--
-- The question this answers is "is the funnel working", which the existing
-- get_email_stats cannot: that counts every email we send, so an offer to a
-- network florist and a day-7 recruiting touch are the same row to it. This one
-- is scoped to `kind like 'recruit.%'` and reports PER STEP, because the only
-- useful version of "is it working" is which angle earns the click.
--
-- Two deliberate choices about what is counted:
--
--   * CLICKS come from email_events. That includes clicks the funnel itself
--     REFUSED to act on — a link scanner's click is stored but never moves an
--     enrolment (lib/sequences/clickQuality.ts). Showing the raw number next to
--     the engaged count is the point: if most "clicks" on a step are machines,
--     that is the single most useful thing this page can tell you, and hiding
--     them would make the step look like it is working.
--
--   * JOINED is attributed to the enrolment, not to a click. A florist who
--     joins is `converted`; we do not try to credit a particular touch, because
--     with four touches and a magic link we cannot honestly say which one did it.
create or replace function get_funnel_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_steps jsonb;
  v_enrolments jsonb;
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  -- Per-step sends and clicks. `kind` is 'recruit.<step>' (lib/sequences/
  -- definitions.ts::stepKind), so the suffix IS the step.
  select coalesce(jsonb_agg(row_to_json(s)), '[]'::jsonb) into v_steps
  from (
    select
      substring(c.kind from 'recruit\.(.*)$') as step,
      c.channel,
      count(*) filter (where c.status = 'sent')    as sent,
      count(*) filter (where c.status = 'skipped') as skipped,
      count(*) filter (where c.status = 'failed')  as failed,
      count(distinct e.id) filter (where e.event_type = 'delivered') as delivered,
      count(distinct e.id) filter (where e.event_type = 'clicked')   as clicked,
      count(distinct e.id) filter (where e.event_type = 'bounced')   as bounced
    from communications c
    left join email_events e on e.communication_id = c.id
    where c.kind like 'recruit.%'
      and c.created_at >= p_from::timestamptz
      and c.created_at < (p_to + 1)::timestamptz
    group by 1, 2
    order by 1, 2
  ) s;

  -- Where runs stand and how they ended. `stop_reason` is the honest version of
  -- "why did this stop" — exhausted is the normal end, not a failure.
  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_enrolments
  from (
    select
      sequence_id,
      status,
      coalesce(stop_reason, '') as stop_reason,
      count(*) as n,
      count(*) filter (where engaged_at is not null) as engaged
    from sequence_enrolments
    where created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz
    group by 1, 2, 3
    order by 1, 2, 3
  ) x;

  result := jsonb_build_object('steps', v_steps, 'enrolments', v_enrolments);
  return result;
end;
$$;

revoke all on function get_funnel_stats(date, date) from public;
grant execute on function get_funnel_stats(date, date) to authenticated;

comment on function get_funnel_stats(date, date) is
  'Outreach funnel numbers for /statistics: per-step sends/clicks from communications+email_events, and enrolment outcomes from sequence_enrolments. Scoped to kind like ''recruit.%'' so it answers "is the funnel working" rather than "how much mail did we send". Clicks are the RAW event count and deliberately include scanner clicks the funnel refused to act on — see lib/sequences/clickQuality.ts.';
