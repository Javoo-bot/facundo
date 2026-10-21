-- Which calendar days the statistics date picker is allowed to offer.
--
-- The picker greys out days we have nothing for, exactly as it greys out the
-- future (components/statistics/DateRangePicker.tsx). Before this function it
-- could only do the future half, because "does 14 January have anything in it"
-- is not a question the client can answer without the data it is trying to
-- decide whether to ask for.
--
-- ---- Three deliberate choices:
--
-- 1. ORDERS ARE THE CLOCK, FOR EVERY STATISTICS VIEW — including the recruiting
--    funnel, whose own table is far sparser. The owner's call (2026-09-04), and the
--    reason is what the alternative does: prod holds exactly one recruiting
--    enrolment (11 Aug 2026), so a funnel calendar gated on its own table would
--    grey out 42 of 43 days INCLUDING TODAY, which is the page's default range.
--    The picker would then open on a day it refuses to let you pick. Gating
--    every view on "was the business running that day" keeps one honest meaning
--    for a greyed day — "we were not trading" — and leaves "we were trading and
--    the funnel did nothing" to the funnel's own empty state, which says so in
--    words. A dead calendar cannot make that distinction; a sentence can.
--
-- 2. IT RETURNS THE DAYS, NOT A MIN/MAX SPAN. A span would re-open the gaps:
--    prod has orders on 24 July and 26 July but none on the 25th, and offering
--    a day that will render an empty page is the thing this function exists to
--    prevent. The set is small by construction — one row per trading day, ~40
--    at time of writing, a few thousand after a decade — so the honest answer
--    is also the cheap one.
--
-- 3. DATES ARE UTC, matching every other stats RPC: get_orders_stats and its
--    siblings bound on `created_at >= p_from::timestamptz`, which resolves in
--    the database timezone. Bucketing here by anything else would let the
--    picker offer a day those functions then report as empty.
--
-- Same `is_email_allowed()` guard as every other function in this family: it is
-- `security definer` and EXECUTE is granted to `authenticated`, which florist
-- sessions are too.
create or replace function get_stats_active_days()
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

  select coalesce(jsonb_agg(d order by d), '[]'::jsonb) into result
  from (
    select distinct (created_at at time zone 'UTC')::date as d
    from orders
  ) days;

  return result;
end;
$$;

grant execute on function get_stats_active_days() to authenticated;

-- There was no plain btree on orders.created_at — the existing order indexes
-- cover deleted_at/shopify_created_at, worklist_at, delivery_at and tags, none
-- of which help here. Without it this function seq-scans every order on every
-- statistics page load. With it the distinct-day scan is index-only.
create index if not exists orders_created_at_idx on orders(created_at);
