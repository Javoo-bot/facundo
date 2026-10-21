-- The recruiting funnel drawn as a funnel: how many SHOPS entered each step.
--
-- Distinct from get_funnel_stats (2026-08-08), which reports per TOUCH — "which
-- angle earns the click". This one answers the other question, the one the team
-- actually opens /statistics to ask: WHERE ARE WE LOSING FLORISTS. So the unit
-- here is one shop, not one message, and the stages are nested subsets.
--
-- ---- Four deliberate choices, because each one changes what the number means:
--
-- 1. IT IS A COHORT FUNNEL, NOT A WINDOW COUNT. The range picks the shops whose
--    outreach STARTED in it; their opens, clicks and joins are then counted
--    whenever they happened, including after p_to. Bounding the downstream
--    events by p_to too would report a 3-day range as ~0% conversion forever,
--    because the day-7 touch that earns most clicks has not been sent yet. The
--    cost is that a recent cohort is still in flight — `still_running` is
--    returned so the UI can say so out loud rather than let a half-finished
--    cohort read as a bad one.
--
-- 2. THE STAGES ARE MONOTONE BY CONSTRUCTION, using downstream evidence to
--    prove upstream stages. A click PROVES the message was seen, and being seen
--    PROVES it was delivered, whether or not the `delivered` webhook ever
--    arrived. Deriving "delivered" from the delivered event ALONE would draw a
--    funnel that widens in the middle — which reads as a broken chart rather
--    than as the missing-webhook fact it actually is.
--
-- 3. "SEEN" AND "CLICKED" SPAN BOTH CHANNELS, so the stage names are about the
--    message and not the medium: touch 1 goes out as email AND SMS, and an SMS
--    has no open pixel — only a short-link hit. Counting only email opens would
--    score every SMS-only reader as a shop that ignored us.
--
-- 4. "CLICKED" IS THE ENGAGED CLICK (`sequence_enrolments.engaged_at`), not the
--    raw email_events count. engaged_at is written only for clicks that passed
--    lib/sequences/clickQuality.ts, so corporate link scanners — which open
--    every URL in every inbound mail — are not counted as interested humans.
--    The raw count is returned SEPARATELY as `clicked_raw`: the gap between the
--    two IS the scanner traffic, and it is the most useful thing this page can
--    say about a step whose click rate looks too good.
--
-- ---- The measurement blind spot, reported rather than hidden:
--
-- email_events is populated by the Resend webhook only. Staging runs Ongage
-- (lib/emailTransport.ts), which has no delivery/open/click feedback at all, so
-- there EVERY sent mail lands in `no_feedback`. Without that number the funnel
-- would show a 100% cliff at "opened it" and be read as a catastrophic open
-- rate when the truth is that nobody is reporting opens at all. `no_feedback`
-- is what lets the UI tell those two apart.
-- `communications` has indexes on order_id and created_at only, and this
-- function joins it by FLORIST — a sequential scan over every message the
-- system has ever sent, growing with every order. One shop's message history is
-- also what /florists/<id> and any future per-shop audit want, so the index
-- earns its keep beyond this page.
create index if not exists communications_florist_idx
  on communications (florist_id, created_at desc);

create or replace function get_visual_funnel_stats(p_from date, p_to date)
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

  with
  -- The cohort: one row per SHOP whose recruiting outreach started in range.
  -- Prospect sequences only (lib/sequences/definitions.ts, audience 'prospect')
  -- — a reactivation run is addressed to a florist who already joined, so it
  -- belongs to a different funnel and would corrupt the join rate of this one.
  cohort as (
    select florist_id, min(created_at) as first_enrolled_at
    from sequence_enrolments
    where sequence_id in ('recruit_cold', 'cold_offer_followup')
      and created_at >= p_from::timestamptz
      and created_at < (p_to + 1)::timestamptz
    group by 1
  ),
  -- Recruiting messages to those shops, from their enrolment onwards. Both
  -- kinds: 'recruiting' is the manual day-0 send from the outreach panel,
  -- 'recruit.<step>' is every touch the tick sends afterwards.
  --
  -- THE HOUR OF SLACK IS LOAD-BEARING. app/api/outreach/send/route.ts SENDS
  -- first and enrols second — the send IS what enrols them — so the day-0
  -- communications row is written BEFORE `first_enrolled_at`. A bound of
  -- `>= first_enrolled_at` would discard the most important message in the
  -- funnel and report every shop as never messaged. An hour absorbs that
  -- ordering and any batch latency, while still keeping a re-enrolment next
  -- season (weeks or months later) from inheriting the previous run's mail.
  msg as (
    select
      c.florist_id,
      count(*) filter (where c.status = 'sent')    as sent,
      count(*) filter (where c.status = 'skipped') as skipped
    from communications c
    join cohort k on k.florist_id = c.florist_id
    where (c.kind = 'recruiting' or c.kind like 'recruit.%')
      and c.created_at >= k.first_enrolled_at - interval '1 hour'
    group by 1
  ),
  -- Provider feedback on those messages. Email only — this table is fed by the
  -- Resend webhook and there is no carrier equivalent for SMS. Same window as
  -- `msg` above, for the same send-before-enrol reason.
  ev as (
    select
      c.florist_id,
      count(*) filter (where e.event_type = 'delivered')  as delivered,
      count(*) filter (where e.event_type = 'opened')     as opened,
      count(*) filter (where e.event_type = 'clicked')    as clicked,
      count(*) filter (where e.event_type = 'bounced')    as bounced
    from communications c
    join cohort k on k.florist_id = c.florist_id
    join email_events e on e.communication_id = c.id
    where (c.kind = 'recruiting' or c.kind like 'recruit.%')
      and c.created_at >= k.first_enrolled_at - interval '1 hour'
    group by 1
  ),
  -- How the shop's runs stand. engaged_at is the scanner-filtered click, on any
  -- channel; the stop reasons are the funnel's own account of why it ended.
  run as (
    select
      florist_id,
      count(*) filter (where engaged_at is not null)         as engaged_runs,
      count(*) filter (where status in ('active', 'paused')) as live_runs,
      count(*) filter (where stop_reason = 'opted_out')      as opted_out_runs
    from sequence_enrolments
    where sequence_id in ('recruit_cold', 'cold_offer_followup')
      and florist_id in (select florist_id from cohort)
    group by 1
  ),
  -- One row per shop with every flag it needs, so the aggregate below is a
  -- plain count of booleans that can be read off the page and checked by hand.
  --
  -- Excluded and deleted shops stay IN: they were mailed, so dropping them
  -- would quietly improve every rate below by deleting the losses.
  shop as (
    select
      k.florist_id,
      k.first_enrolled_at,
      coalesce(m.sent, 0)      as sent,
      coalesce(m.skipped, 0)   as skipped,
      coalesce(v.delivered, 0) as ev_delivered,
      coalesce(v.opened, 0)    as ev_opened,
      coalesce(v.clicked, 0)   as ev_clicked,
      coalesce(v.bounced, 0)   as ev_bounced,
      coalesce(r.engaged_runs, 0)   as engaged_runs,
      coalesce(r.live_runs, 0)      as live_runs,
      coalesce(r.opted_out_runs, 0) as opted_out_runs,
      f.joined_at
    from cohort k
    join florists f on f.id = k.florist_id
    left join msg m on m.florist_id = k.florist_id
    left join ev  v on v.florist_id = k.florist_id
    left join run r on r.florist_id = k.florist_id
  ),
  -- The nested predicates. Each stage's condition implies the one above it —
  -- see choice 2 in the header — so the funnel can never widen.
  staged as (
    select
      *,
      (sent > 0) as st_messaged,
      (sent > 0 and (ev_delivered > 0 or ev_opened > 0
                     or ev_clicked > 0 or engaged_runs > 0)) as st_delivered,
      (sent > 0 and (ev_opened > 0 or ev_clicked > 0
                     or engaged_runs > 0)) as st_seen,
      (sent > 0 and engaged_runs > 0) as st_clicked,
      (joined_at is not null and joined_at >= first_enrolled_at) as st_joined
    from shop
  )
  select jsonb_build_object(
    'picked',    count(*),
    'messaged',  count(*) filter (where st_messaged),
    'delivered', count(*) filter (where st_delivered),
    'seen',      count(*) filter (where st_seen),
    'clicked',   count(*) filter (where st_clicked),
    'joined',    count(*) filter (where st_joined),
    -- Diagnostics behind the drop at each step.
    'never_messaged', count(*) filter (where sent = 0),
    'skipped_only',   count(*) filter (where sent = 0 and skipped > 0),
    'bounced',        count(*) filter (where ev_bounced > 0),
    'opted_out',      count(*) filter (where opted_out_runs > 0),
    -- Sent, and then complete silence — no provider event and no click. On the
    -- Ongage transport this is every shop, and it is the difference between
    -- "nobody opened it" and "nobody told us whether anybody opened it".
    'no_feedback',    count(*) filter (where sent > 0 and ev_delivered = 0 and ev_opened = 0
                                         and ev_clicked = 0 and ev_bounced = 0 and engaged_runs = 0),
    -- Raw email clicks INCLUDING link scanners. The gap against 'clicked' is
    -- the machine traffic; see choice 4 in the header.
    'clicked_raw',    count(*) filter (where ev_clicked > 0),
    -- Still mid-sequence: this cohort's funnel is not finished yet.
    'still_running',  count(*) filter (where live_runs > 0)
  )
  into result
  from staged;

  return coalesce(result, '{}'::jsonb);
end;
$$;

revoke all on function get_visual_funnel_stats(date, date) from public;
grant execute on function get_visual_funnel_stats(date, date) to authenticated;

comment on function get_visual_funnel_stats(date, date) is
  'Shop-level recruiting funnel for /statistics/funnel: picked -> messaged -> delivered -> seen -> clicked -> joined, one shop per row, stages nested so the funnel cannot widen. A COHORT funnel (the range selects who entered; downstream events are counted whenever they happened), so `still_running` must be shown alongside it. `no_feedback` counts shops we sent to and then heard nothing about, which on the Ongage transport is all of them; without it a missing webhook reads as a zero open rate. Per-TOUCH numbers ("which angle earns the click") live in get_funnel_stats instead.';
