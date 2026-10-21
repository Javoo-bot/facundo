-- How long to leave a florist alone after they did not pick up.
--
-- The call screen records an unanswered call (`call_no_answer`) and puts that
-- shop below the untried ones for a while, so the next operator is not handed
-- the same number a minute later. That "while" shipped as a hard-coded ladder
-- because nobody had calibrated it, and a number nobody has calibrated should
-- not arrive with a settings row implying somebody did.
--
-- The desk now wants to set it, so it becomes four columns alongside the offer
-- windows it is modelled on. Same tiers, same reasoning: the judgement is how
-- much time there is to be patient with. A rush order is rung back inside ten
-- minutes; one four days out is left for two hours rather than pestered.
--
-- Defaults are exactly the shipped constants, so applying this migration alone
-- changes no behaviour.

alter table app_settings
  add column if not exists call_back_gap_rush_min     integer not null default 10,
  add column if not exists call_back_gap_sameday_min  integer not null default 20,
  add column if not exists call_back_gap_standard_min integer not null default 45,
  add column if not exists call_back_gap_far_min      integer not null default 120,
  add column if not exists call_back_gap_nodate_min   integer not null default 45;

comment on column app_settings.call_back_gap_rush_min is
  'Minutes to wait before offering the same shop again after an unanswered call, '
  'for a delivery within 6h. Tiers mirror offer_window_*_min.';
