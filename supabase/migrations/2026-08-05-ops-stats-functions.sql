-- /statistics aggregation, done in SQL instead of PostgREST selects.
--
-- lib/opsStats.ts used to `select(...)` raw rows and count/group them in
-- JavaScript. PostgREST caps a `select` at 1000 rows by default, so every
-- metric derived from more than 1000 rows in the selected range was silently
-- wrong (e.g. "Orders, last 30d" showed 1000 when the real count was 3983).
-- These functions push the count/group-by/percentile work into Postgres so
-- no metric depends on how many rows PostgREST would hand back.
--
-- The range is INCLUSIVE on both ends, matching what lib/opsStats.ts's
-- StatsRange documents and what the date picker shows. Every filter below is
-- therefore `>= p_from::timestamptz and < (p_to + 1)::timestamptz`, never
-- `<= p_to::timestamptz` — a date cast to timestamptz lands on *midnight at the
-- start* of that day, so the `<=` form silently dropped essentially the whole
-- final day. Confirmed before the fix: a day with 23 orders reported 0 when
-- queried as from = to = that day, and the default 30-day view never included
-- today (defaultRange() sets to = today).
--
-- security definer + set search_path = public, matching
-- run_readonly_stats_query and finalize_payout/clawback_order. Unlike those,
-- this is called from the RLS-backed anon-key+JWT client (the page needs a
-- real staff session, not the service-role client), so bypassing RLS is the
-- point here too: staff already get full-table read access to every table
-- touched below via "allowlisted read X" policies keyed on
-- is_email_allowed() (see supabase/migrations/2026-07-13-phase0-orders.sql,
-- 2026-07-14-order-issues.sql, 2026-07-24-communications.sql,
-- 2026-08-05-login-events.sql, 2026-08-05-email-events.sql) — these
-- functions compute the exact same rows an allow-listed staff member could
-- already read one-by-one, just aggregated and uncapped.
--
-- That RLS bypass is exactly why each function starts with its own
-- is_email_allowed() check: EXECUTE is granted to `authenticated`, and
-- florists are `authenticated` too (see current_florist_id() /
-- "florist reads own communications"). Without the in-function check, a
-- florist session could call these RPCs directly and read aggregate order/
-- assignment/issue data that RLS would otherwise deny them outright (florists
-- have no read policy at all on orders, order_assignments, order_issues,
-- login_events, or email_events). The page-level role gate (ops/admin only)
-- in app/(staff)/statistics/page.tsx stays as the UI-level restriction; this
-- is the data-level backstop, mirroring how every other allowlisted-read
-- policy in this schema already works.

-- 1. Orders: total, by-status breakdown, by-day series.
create or replace function get_orders_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  with in_range as (
    select status, created_at
    from orders
    where created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz
  )
  select jsonb_build_object(
    'totalOrders', (select count(*) from in_range),
    'byStatus', coalesce((
      select jsonb_object_agg(status, cnt) from (
        select status, count(*) as cnt from in_range where status is not null group by status
      ) s
    ), '{}'::jsonb),
    'byDay', coalesce((
      select jsonb_agg(jsonb_build_object('date', day, 'count', cnt) order by day) from (
        select (created_at at time zone 'utc')::date::text as day, count(*) as cnt
        from in_range group by day
      ) d
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function get_orders_stats(date, date) from public, anon;
grant execute on function get_orders_stats(date, date) to authenticated;

-- 2. Acceptance: total assignments, accept rate, decline/release reason breakdowns.
create or replace function get_acceptance_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_accepted integer;
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select count(*), count(*) filter (where status in ('accepted', 'delivered'))
    into v_total, v_accepted
  from order_assignments
  where assigned_at >= p_from::timestamptz and assigned_at < (p_to + 1)::timestamptz;

  select jsonb_build_object(
    'totalAssignments', v_total,
    'acceptedCount', v_accepted,
    'acceptRate', case when v_total > 0 then v_accepted::numeric / v_total else null end,
    'declineReasons', coalesce((
      select jsonb_object_agg(decline_reason, cnt) from (
        select decline_reason, count(*) as cnt from order_assignments
        where assigned_at >= p_from::timestamptz and assigned_at < (p_to + 1)::timestamptz
          and status = 'declined' and decline_reason is not null
        group by decline_reason
      ) s
    ), '{}'::jsonb),
    'releaseReasons', coalesce((
      select jsonb_object_agg(decline_reason, cnt) from (
        select decline_reason, count(*) as cnt from order_assignments
        where assigned_at >= p_from::timestamptz and assigned_at < (p_to + 1)::timestamptz
          and status = 'released' and decline_reason is not null
        group by decline_reason
      ) s
    ), '{}'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function get_acceptance_stats(date, date) from public, anon;
grant execute on function get_acceptance_stats(date, date) to authenticated;

-- 3. Fulfilment: completion/on-time rates + a time-to-delivery histogram
--    (6h buckets, 0-48h, last bucket catches the rest — matches the bucketing
--    FulfilmentSection.tsx used to do client-side over the raw array).
create or replace function get_fulfilment_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_accepted_count  integer;
  v_delivered_count integer;
  v_with_deadline   integer;
  v_on_time_count   integer;
  v_histogram       jsonb;
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select
    count(*) filter (where status in ('accepted', 'delivered')),
    count(*) filter (where status = 'delivered' and delivered_at is not null),
    count(*) filter (where status = 'delivered' and delivered_at is not null and sla_deadline_at is not null),
    count(*) filter (where status = 'delivered' and delivered_at is not null and sla_deadline_at is not null
                        and delivered_at <= sla_deadline_at)
    into v_accepted_count, v_delivered_count, v_with_deadline, v_on_time_count
  from order_assignments
  where assigned_at >= p_from::timestamptz and assigned_at < (p_to + 1)::timestamptz
    and status in ('accepted', 'delivered', 'reassigned', 'released');

  with hours as (
    select extract(epoch from (delivered_at - assigned_at)) / 3600.0 as h
    from order_assignments
    where assigned_at >= p_from::timestamptz and assigned_at < (p_to + 1)::timestamptz
      and status in ('accepted', 'delivered', 'reassigned', 'released')
      and status = 'delivered' and delivered_at is not null and assigned_at is not null
  ),
  bucketed as (
    select least(floor(h / 6)::int, 7) as idx from hours
  ),
  buckets as (
    select gs.idx, coalesce(b.cnt, 0) as cnt
    from generate_series(0, 7) as gs(idx)
    left join (select idx, count(*) as cnt from bucketed group by idx) b using (idx)
  )
  select jsonb_agg(
    jsonb_build_object('bucket', (idx * 6)::text || '-' || ((idx + 1) * 6)::text || 'h', 'count', cnt)
    order by idx
  ) into v_histogram
  from buckets;

  result := jsonb_build_object(
    'acceptedCount', v_accepted_count,
    'deliveredCount', v_delivered_count,
    'completionRate', case when v_accepted_count > 0 then v_delivered_count::numeric / v_accepted_count else null end,
    'onTimeCount', v_on_time_count,
    'onTimeRate', case when v_with_deadline > 0 then v_on_time_count::numeric / v_with_deadline else null end,
    'timeToDeliveryHistogram', coalesce(v_histogram, '[]'::jsonb)
  );

  return result;
end;
$$;

revoke all on function get_fulfilment_stats(date, date) from public, anon;
grant execute on function get_fulfilment_stats(date, date) to authenticated;

-- 4. Issues: totals, by-type breakdown, median resolution time (a raw
--    per-issue array would be another unbounded-to-the-browser list; the
--    current UI (IssuesSection.tsx) doesn't chart the distribution today, so
--    a single summary stat is the honest replacement).
create or replace function get_issues_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_open integer;
  v_resolved integer;
  v_by_type jsonb;
  v_median double precision;
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select
    count(*),
    count(*) filter (where status = 'open'),
    count(*) filter (where status = 'resolved' and resolved_at is not null)
    into v_total, v_open, v_resolved
  from order_issues
  where created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz;

  select coalesce(jsonb_object_agg(type, cnt), '{}'::jsonb) into v_by_type
  from (
    select type, count(*) as cnt from order_issues
    where created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz and type is not null
    group by type
  ) s;

  select percentile_cont(0.5) within group (order by extract(epoch from (resolved_at - created_at)) / 3600.0)
    into v_median
  from order_issues
  where created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz
    and status = 'resolved' and resolved_at is not null;

  result := jsonb_build_object(
    'totalIssues', v_total,
    'openCount', v_open,
    'resolvedCount', v_resolved,
    'byType', v_by_type,
    'resolutionTimeHoursMedian', v_median
  );

  return result;
end;
$$;

revoke all on function get_issues_stats(date, date) from public, anon;
grant execute on function get_issues_stats(date, date) to authenticated;

-- 5. Usage: distinct active florists per day + median offer response time.
--    The median replicates the JS behavior exactly (sort, index at
--    floor(n/2), NOT an average-of-two-middles for even n) via row_number()
--    rather than percentile_cont/percentile_disc, neither of which matches
--    that tie-break for even-sized samples.
create or replace function get_usage_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_active_by_day jsonb;
  v_median_minutes double precision;
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('date', day, 'count', cnt) order by day), '[]'::jsonb)
    into v_active_by_day
  from (
    select (occurred_at at time zone 'utc')::date::text as day, count(distinct florist_id) as cnt
    from login_events
    where surface = 'florist' and florist_id is not null
      and occurred_at >= p_from::timestamptz and occurred_at < (p_to + 1)::timestamptz
    group by day
  ) d;

  with resp as (
    select extract(epoch from (coalesce(accepted_at, declined_at) - sent_at)) / 60.0 as minutes
    from order_assignments
    where assigned_at >= p_from::timestamptz and assigned_at < (p_to + 1)::timestamptz
      and sent_at is not null and coalesce(accepted_at, declined_at) is not null
  ),
  ranked as (
    select minutes, row_number() over (order by minutes) as rn, count(*) over () as n
    from resp
  )
  select minutes into v_median_minutes from ranked where rn = (n / 2) + 1;

  result := jsonb_build_object(
    'activeFloristsByDay', v_active_by_day,
    'medianResponseMinutes', v_median_minutes
  );

  return result;
end;
$$;

revoke all on function get_usage_stats(date, date) from public, anon;
grant execute on function get_usage_stats(date, date) to authenticated;

-- 6. Logins: staff vs florist sign-ins per day.
create or replace function get_login_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_staff jsonb;
  v_florist jsonb;
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('date', day, 'count', cnt) order by day), '[]'::jsonb) into v_staff
  from (
    select (occurred_at at time zone 'utc')::date::text as day, count(*) as cnt
    from login_events
    where surface = 'staff' and occurred_at >= p_from::timestamptz and occurred_at < (p_to + 1)::timestamptz
    group by day
  ) s;

  select coalesce(jsonb_agg(jsonb_build_object('date', day, 'count', cnt) order by day), '[]'::jsonb) into v_florist
  from (
    select (occurred_at at time zone 'utc')::date::text as day, count(*) as cnt
    from login_events
    where surface = 'florist' and occurred_at >= p_from::timestamptz and occurred_at < (p_to + 1)::timestamptz
    group by day
  ) f;

  result := jsonb_build_object('staffLoginsByDay', v_staff, 'floristLoginsByDay', v_florist);

  return result;
end;
$$;

revoke all on function get_login_stats(date, date) from public, anon;
grant execute on function get_login_stats(date, date) to authenticated;

-- 7. Email: sent count from communications, delivery-lifecycle counts from
--    email_events joined directly (no more collecting up to 1000
--    communication_ids client-side and passing them through `.in()`).
create or replace function get_email_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sent integer;
  v_delivered integer;
  v_opened integer;
  v_clicked integer;
  v_bounced integer;
  v_complained integer;
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select count(*) filter (where status = 'sent') into v_sent
  from communications
  where channel = 'email' and created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz;

  select
    count(*) filter (where e.event_type = 'delivered'),
    count(*) filter (where e.event_type = 'opened'),
    count(*) filter (where e.event_type = 'clicked'),
    count(*) filter (where e.event_type = 'bounced'),
    count(*) filter (where e.event_type = 'complained')
    into v_delivered, v_opened, v_clicked, v_bounced, v_complained
  from email_events e
  join communications c on c.id = e.communication_id
  where c.channel = 'email' and c.created_at >= p_from::timestamptz and c.created_at < (p_to + 1)::timestamptz;

  result := jsonb_build_object(
    'sent', v_sent,
    'delivered', coalesce(v_delivered, 0),
    'opened', coalesce(v_opened, 0),
    'clicked', coalesce(v_clicked, 0),
    'bounced', coalesce(v_bounced, 0),
    'complained', coalesce(v_complained, 0)
  );

  return result;
end;
$$;

revoke all on function get_email_stats(date, date) from public, anon;
grant execute on function get_email_stats(date, date) to authenticated;
