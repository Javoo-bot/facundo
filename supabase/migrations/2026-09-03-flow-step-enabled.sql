-- Turning one funnel step off, from /flows, without a deploy.
--
-- WHY on sequence_step_timing rather than a table of its own: it is the same
-- grain (one row per step) with the same key, and a step is very often both
-- retimed and switched off in the same sitting. Two tables would mean two
-- reads in the tick and two ways to say "this step is not its default".
--
-- `days` becomes NULLABLE as part of this: until now a row existed only to
-- carry a custom wait, so its presence MEANT "the wait was overridden". A row
-- can now exist to carry `enabled = false` alone, and null days is how it says
-- "the wait is still the built-in one". Reading code must treat null as
-- absent rather than as zero — a zero wait means "send immediately", which is
-- a completely different instruction (lib/flows/timing.ts::parseTimingRows).
alter table sequence_step_timing alter column days drop not null;

alter table sequence_step_timing
  add column if not exists enabled boolean not null default true;

-- The old constraint rejected null. Same bounds, now null-tolerant.
alter table sequence_step_timing drop constraint if exists sequence_step_timing_days_check;
alter table sequence_step_timing
  add constraint sequence_step_timing_days_check
  check (days is null or (days >= 0 and days <= 90));

comment on column sequence_step_timing.enabled is
  'false = the sequence engine SKIPS this step and moves to the next one (lib/sequences/schedule.ts::nextDecision). Default true; a step with no row is on, with its built-in wait. Set from /flows.';

comment on column sequence_step_timing.days is
  'Days after the step''s anchor, or NULL for the built-in wait in lib/sequences/definitions.ts. NULL is NOT zero — zero means send immediately.';
