-- The statistics date range means a MADRID day, not a UTC one.
--
-- Every get_*_stats function bounds its window as
--   `>= p_from::timestamptz and < (p_to + 1)::timestamptz`
-- and a `date::timestamptz` cast resolves against the SESSION TimeZone, which
-- on Supabase is UTC. So "4 September" has always meant 00:00–24:00 UTC =
-- 02:00–02:00 Madrid, and every order placed in Spain between midnight and 2am
-- was counted on the previous day.
--
-- Measured on production, 2026-09-04: 224 of 6,414 orders (3.5%) sit on a
-- different calendar day under Europe/Madrid than under UTC. For 4 September
-- itself the range reported 18 orders where the Madrid day held 20.
--
-- This was survivable while the shortest range the picker offered was seven
-- days — a boundary order stayed inside the window either way, and only the
-- two ends of a long range were fuzzy. It stopped being survivable when the
-- picker's default became a SINGLE DAY (components/statistics/DateRangePicker
-- .tsx, same day): at a one-day width the misplaced rows fall out of the answer
-- entirely, and between 00:00 and 02:00 Madrid the page reports on a day that
-- has barely begun in UTC — a near-empty screen for the first two hours of
-- every working morning.
--
-- ---- Why this is an ALTER and not eleven rewritten function bodies:
--
-- `date::timestamptz` reads the TimeZone GUC at execution time, and Postgres
-- lets a function carry its own GUC settings. Pinning TimeZone per function
-- therefore fixes every bound inside it — roughly eighteen range clauses spread
-- across four migrations — without restating one line of query logic. Copying
-- those bodies forward to change `p_from::timestamptz` into
-- `timezone('Europe/Madrid', p_from::timestamp)` in each would mean this file
-- silently becoming the new source of truth for logic that belongs to
-- 2026-08-05-ops-stats-functions.sql and its siblings, and any future edit
-- there would have to be mirrored here or be lost. An ALTER cannot drift.
--
-- It also fixes the same-day bucketing inside those functions (any `::date` on
-- a timestamptz now buckets by Madrid day), which is the behaviour we want
-- everywhere and would otherwise have needed its own separate pass.
--
-- ---- Consequences to be aware of:
--
--  * Historical figures move slightly. A number quoted from this page before
--    today can differ by up to that 3.5% of rows for the same range. This is a
--    correction, not a regression — the new figures are the ones that match
--    what a person in Spain means by that date.
--  * It is Madrid specifically, not the viewer's browser timezone. Facundo
--    operates on Spanish time and the numbers must mean one thing for everyone
--    reading them; a per-viewer range would make two people quoting "yesterday"
--    to each other quote different numbers.
--  * Reversible with `alter function … reset TimeZone`, per function.
alter function get_orders_stats(date, date)        set TimeZone = 'Europe/Madrid';
alter function get_acceptance_stats(date, date)    set TimeZone = 'Europe/Madrid';
alter function get_fulfilment_stats(date, date)    set TimeZone = 'Europe/Madrid';
alter function get_issues_stats(date, date)        set TimeZone = 'Europe/Madrid';
alter function get_usage_stats(date, date)         set TimeZone = 'Europe/Madrid';
alter function get_login_stats(date, date)         set TimeZone = 'Europe/Madrid';
alter function get_messaging_stats(date, date)     set TimeZone = 'Europe/Madrid';
alter function get_email_stats(date, date)         set TimeZone = 'Europe/Madrid';
alter function get_funnel_stats(date, date)        set TimeZone = 'Europe/Madrid';
alter function get_visual_funnel_stats(date, date) set TimeZone = 'Europe/Madrid';

-- The picker's day list has to agree with the ranges above, or it would grey
-- out a day the RPCs would happily report on (and vice versa at the boundary).
-- Redefined rather than ALTERed because its body names the zone explicitly —
-- see 2026-09-04-stats-active-days.sql for why orders are the clock for every
-- statistics view, funnel included.
create or replace function get_stats_active_days()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set TimeZone = 'Europe/Madrid'
as $$
declare
  result jsonb;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(d order by d), '[]'::jsonb) into result
  from (
    select distinct (created_at at time zone 'Europe/Madrid')::date as d
    from orders
  ) days;

  return result;
end;
$$;
