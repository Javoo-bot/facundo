-- Per-step wait times for the outreach funnels, editable from /flows.
--
-- WHY a table rather than more app_settings columns: the step list grows with
-- every funnel touch (nine already), and app/api/settings/route.ts is a
-- FULL-FORM OVERWRITE — an omitted field is written back as its default. One
-- row per step also means a step that has never been touched has NO row, so
-- the code default in lib/sequences/definitions.ts stays the visible truth
-- instead of being shadowed by a copy of itself.
--
-- WHY `days` numeric rather than minutes: it is the unit lib/sequences/
-- schedule.ts::dueAt already multiplies by, and the cold-offer follow-up
-- already ships a fractional day (co1 = 0.5). Storing anything else would put
-- a conversion between what staff set and what the metronome reads.
--
-- Read best-effort via lib/sequences/timingOverrides.ts and applied by the
-- pure lib/flows/timing.ts::applyStepTiming — an unreadable table means the
-- funnel runs on its code defaults, never that it stops.
create table if not exists sequence_step_timing (
  sequence_id text        not null,
  step_key    text        not null,
  -- Days after the step's anchor. 0 = immediately; 0.5 = twelve hours.
  -- Bounded so a typo cannot park a run past the heat death of the funnel,
  -- and cannot turn a follow-up into a second copy of the touch before it.
  days        numeric(7,3) not null check (days >= 0 and days <= 90),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (sequence_id, step_key)
);

comment on table sequence_step_timing is
  'Staff-editable wait time per funnel step, set from /flows. Overrides SequenceStep.days in lib/sequences/definitions.ts; a missing row means the code default. Applied in lib/flows/timing.ts::applyStepTiming.';

alter table sequence_step_timing enable row level security;

-- Reads under the user's JWT, same allow-list gate every staff-facing table
-- uses. Writes go through the service role in app/api/flows, which is where
-- the range + known-step validation lives.
drop policy if exists "allowlisted read sequence_step_timing" on sequence_step_timing;
create policy "allowlisted read sequence_step_timing" on sequence_step_timing
  for select to authenticated
  using (public.is_email_allowed());
