-- Offer-wave refill: keep trying florists instead of escalating after one
-- wave of `match_top_n` candidates. See dashboard/lib/waveGuards.ts (the pure
-- stop rules), lib/candidateRefill.ts (the append-mode match) and
-- lib/waves.ts::advanceWaves (the hook, auto mode only).
--
-- Why: matching writes the top `match_top_n` (3) shops as candidates and the
-- wave engine works down that chain one at a time. When the third offer lapsed
-- the order escalated to CX — even in a city where 25 more contactable shops
-- were in range and never asked. Observed on the 2026-08-20 QA run (#MOCK-9204,
-- York): escalated `candidates_exhausted` after 3 offers with 28 emailable
-- florists inside the 20 km cap.
--
-- Two guards bound the new loop, because "keep going until someone says yes"
-- has to stop somewhere:
--   * match_max_waves  — a hard ceiling on waves per order (4 × 3 = 12 shops).
--   * cx_reserve_hours — stop early enough that a HUMAN still has time to place
--     the order by hand. The loop refuses a wave whose window would run past
--     `delivery_at - cx_reserve_hours`.
-- Distinct from late_accept_buffer_hours, which answers a different question
-- (how late a lapsed florist yes still counts), even though both default to 2.
alter table app_settings
  add column if not exists match_max_waves   integer not null default 4,
  add column if not exists cx_reserve_hours  integer not null default 2;

comment on column app_settings.match_max_waves is
  'Hard ceiling on offer waves per order. Each wave refills up to match_top_n fresh candidates, so the most shops an order can be offered to unattended is match_max_waves × match_top_n. Reaching it escalates with reason wave_ceiling — untried shops may remain, which is why the CX desk offers "keep going" rather than only "place by hand". 1 = the pre-refill behavior (one wave, then escalate).';

comment on column app_settings.cx_reserve_hours is
  'Margin before delivery reserved for a human. The wave engine will not start an offer whose response window would end later than delivery_at minus this, escalating with reason out_of_time instead — so CX inherits the order while there is still time to place it. Orders with no delivery_at are bounded by match_max_waves alone.';

-- Why the escalation reason lives on the ORDER and not only in order_events:
-- the CX desk (lib/cxAttention.ts) already selects the order rows it triages,
-- and "no florist exists here" vs "12 shops ignored us" vs "we ran out of
-- clock" need different humans doing different things. A column keeps that a
-- filter and a join-free read; the matching order_events row stays the audit
-- trail. Only meaningful while status = 'escalated' — a late accept clears the
-- status, not this column.
alter table orders
  add column if not exists escalation_reason text;

comment on column orders.escalation_reason is
  'Why the wave engine escalated: pool_exhausted (every matchable shop in range was tried), wave_ceiling (hit match_max_waves, untried shops may remain), out_of_time (stopped to leave cx_reserve_hours for a human), past_delivery_deadline. Read only while status = ''escalated''. Legacy rows predating this column are null, and older events may carry the retired reason ''candidates_exhausted'', which is treated as pool_exhausted.';

-- The CX desk filters escalated orders by reason; keep that a partial index
-- rather than a full one — escalated is a small slice of the table.
create index if not exists orders_escalation_reason_idx
  on orders (escalation_reason)
  where status = 'escalated';
