-- Reach Out — the pieces the Spain recruiting push needs that the schema did
-- not already have. Additive and idempotent; all three ship DARK in the sense
-- that nothing here starts a send on its own.
--
-- 1. sequence_auto_enrol_countries — country scope for the auto-enrol sweep.
-- 2. sequence_enrolments.opened_at  — the open signal, mirroring engaged_at.
-- 3. get_reachout_signals()         — the ranked call list's read model.

-- ---------------------------------------------------------------------------
-- 1. Country scope for auto-enrol.
--
-- `sequence_auto_enrol_scraped` is a GLOBAL switch: it enrols every freshly
-- scraped shop with an email, in every country. Measured on prod the day this
-- shipped, flipping it for a Spain campaign would have enrolled 720 shops of
-- which 16 were Spanish (DK 158, FR 127, IL 122, CH 82, SE 68…). Since the
-- daily send cap is the scarce resource, that is not a harmless superset — it
-- is Spain receiving 2% of its own campaign.
--
-- NULL (and empty) means EVERY country, so this column cannot change the
-- behaviour of an existing row: un-migrated semantics are preserved exactly.
alter table app_settings
  add column if not exists sequence_auto_enrol_countries text[];

comment on column app_settings.sequence_auto_enrol_countries is
  'Country allow-list for the auto-enrol sweep, using the codes cities.country stores (ISO-2 on live data). NULL or empty = every country, which is the pre-column behaviour. Scopes sequence_auto_enrol_scraped, which is otherwise global and would spend the daily send cap on whichever country was scraped most recently. See dashboard/lib/sequences/autoEnrol.ts.';

-- ---------------------------------------------------------------------------
-- 2. The open signal.
--
-- Deliberately a COLUMN on the enrolment rather than a join to email_events on
-- every tick, for the same reason engaged_at is one: the scheduler asks "what
-- is this run's state?" once per due row, per minute, and a per-row join over a
-- table that grows with every send would put the funnel's latency on the wrong
-- curve. The webhook writes it once, CAS-guarded, exactly like engaged_at.
--
-- Nullable with no default and no backfill: NULL means "no genuine open
-- recorded", which for every pre-existing run is the truth. Note that NULL is
-- NOT the same as "did not open" in the scheduler — see OpenState in
-- dashboard/lib/sequences/openState.ts, where the absence of ANY provider
-- feedback resolves to `unknown` and must not block a step.
alter table sequence_enrolments
  add column if not exists opened_at timestamptz;

comment on column sequence_enrolments.opened_at is
  'First genuine (openQuality-passing) email open on this run, written CAS-guarded by the Resend webhook. Mirrors engaged_at. NULL means no open was RECORDED, which is not the same as "did not open" — with no provider feedback at all the scheduler resolves OpenState to `unknown` and refuses to gate on it.';

-- Partial index mirroring sequence_enrolments_due: the tick only ever reads
-- opened_at for runs it is already considering, which are the active ones.
create index if not exists sequence_enrolments_open_pending
  on sequence_enrolments (florist_id)
  where status = 'active' and opened_at is null;

-- ---------------------------------------------------------------------------
-- 3. The ranked call list's read model.
--
-- Returns one row per SHOP with the raw signals; the ranking arithmetic lives
-- in dashboard/lib/reachout/ranking.ts, deliberately. Two reasons: the formula
-- is the thing most likely to be argued about and adjusted, and a pure TS
-- function is unit-testable in a way a scoring expression buried in SQL is not
-- (see lib/scoring.ts, which pairs with the discovery table the same way).
-- So SQL does the expensive joins once and TS decides the order.
--
-- Scoped by COUNTRY rather than by campaign: there is no campaign table, and
-- "Spanish shops in the recruiting funnel" is the whole population by
-- definition. p_country is matched case-insensitively against cities.country.
--
-- Prospect sequences only. A reactivation run targets a florist who already
-- joined, so mixing it in would put network members in a list whose entire
-- purpose is deciding who to recruit next.
create or replace function get_reachout_signals(p_country text)
returns table (
  florist_id uuid,
  name text,
  city text,
  email text,
  phone text,
  rating double precision,
  review_count integer,
  joined_at timestamptz,
  engaged_at timestamptz,
  opened_at timestamptz,
  click_count bigint,
  open_count bigint,
  delivered_count bigint,
  bounced_count bigint,
  touches_sent bigint,
  suppressed boolean,
  enrolled boolean,
  last_signal_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  return query
  with shop as (
    select f.id, f.name, c.city, f.email,
           -- The number CS actually dials. phone_mobile is florist-confirmed
           -- (they typed it on the join form), so it beats anything scraped;
           -- phone_web came off their own site; phone_maps is the listing.
           coalesce(f.phone_mobile, f.phone_web, f.phone_maps) as phone,
           f.rating, f.review_count, f.joined_at
    from florists f
    join cities c on c.id = f.city_id
    where c.country ilike p_country
      and f.deleted_at is null
      and f.excluded_at is null
      -- Our own shops are not prospects.
      and coalesce(f.is_test_shop, false) = false
  ),
  -- One row per shop, folding however many runs it has had.
  run as (
    select e.florist_id,
           min(e.engaged_at) as engaged_at,
           min(e.opened_at)  as opened_at,
           bool_or(e.stop_reason in ('bounced', 'opted_out')) as suppressed,
           count(*) as runs
    from sequence_enrolments e
    join shop s on s.id = e.florist_id
    where e.sequence_id in ('recruit_cold', 'cold_offer_followup')
    group by 1
  ),
  -- Recruiting mail actually sent, and what the provider said about it. The
  -- LEFT JOIN matters: a shop we mailed and heard nothing about must come back
  -- with touches_sent > 0 and zero events, which is what separates tier 4
  -- ("sent, no feedback") from tier 3 ("delivered, never opened").
  msg as (
    select cm.florist_id,
           count(distinct cm.id) as touches_sent,
           count(*) filter (where ev.event_type = 'delivered')  as delivered_count,
           count(*) filter (where ev.event_type = 'opened')     as open_count,
           count(*) filter (where ev.event_type = 'clicked')    as click_count,
           count(*) filter (where ev.event_type in ('bounced','complained')) as bounced_count,
           max(ev.occurred_at) filter (where ev.event_type in ('opened','clicked')) as last_signal_at
    from communications cm
    join shop s on s.id = cm.florist_id
    left join email_events ev on ev.communication_id = cm.id
    where cm.channel = 'email'
      and cm.status = 'sent'
      and (cm.kind = 'recruiting' or cm.kind like 'recruit.%')
    group by 1
  )
  select
    s.id, s.name, s.city, s.email, s.phone, s.rating, s.review_count, s.joined_at,
    r.engaged_at, r.opened_at,
    coalesce(m.click_count, 0), coalesce(m.open_count, 0),
    coalesce(m.delivered_count, 0), coalesce(m.bounced_count, 0),
    coalesce(m.touches_sent, 0),
    coalesce(r.suppressed, false),
    (r.runs is not null),
    -- The freshest thing they did. Falls back to the enrolment's own
    -- click/open stamps so a shop whose engagement came through the SMS short
    -- link — which writes engaged_at but no email_event — still has a recency.
    nullif(
      greatest(coalesce(m.last_signal_at, 'epoch'::timestamptz),
               coalesce(r.engaged_at, 'epoch'::timestamptz),
               coalesce(r.opened_at, 'epoch'::timestamptz)),
      'epoch'::timestamptz)
  from shop s
  left join run r on r.florist_id = s.id
  left join msg m on m.florist_id = s.id
  -- SIGNAL FIRST, and this ordering is load-bearing rather than cosmetic.
  -- PostgREST caps a result at 1000 rows, and Spain alone is ~1,950 shops, so
  -- /reach-out was rendering an arbitrary ~1000 of them: "Florists that joined:
  -- 3" against a real 8, and an EMPTY ranking, because the cut fell before every
  -- shop that had engaged. The caller now asks for more than 1000, but a raised
  -- ceiling would fail again the moment a market outgrew it. Sorted by signal, a
  -- truncation can only ever drop shops that have nothing to show — never a
  -- joiner, a clicker or an opener. Mirrors the tiers in
  -- dashboard/lib/reachout/ranking.ts without duplicating the score itself.
  order by
    (s.joined_at is not null) desc,
    (r.engaged_at is not null or coalesce(m.click_count, 0) > 0) desc,
    (r.opened_at is not null or coalesce(m.open_count, 0) > 0) desc,
    coalesce(m.touches_sent, 0) desc,
    (r.runs is not null) desc,
    s.review_count desc nulls last;
end;
$$;

revoke all on function get_reachout_signals(text) from public;
grant execute on function get_reachout_signals(text) to authenticated;

comment on function get_reachout_signals(text) is
  'One row per shop in a country with the raw recruiting signals behind the /reach-out call list: join state, scanner-filtered click, prefetch-filtered open, provider event counts, touches sent and last signal. The RANKING arithmetic is deliberately not here — it lives in dashboard/lib/reachout/ranking.ts so the formula stays unit-testable and adjustable. Prospect sequences only.';
