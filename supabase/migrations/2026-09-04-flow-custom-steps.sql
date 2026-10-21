-- Duplicating a funnel email, from /flows, without a deploy.
--
-- Until now the funnel's SHAPE was code (lib/sequences/definitions.ts) and only
-- its words and waits were data. A duplicate is a genuinely new touch, so this
-- is the one thing that adds a step at runtime — and it is deliberately the
-- ONLY thing that can: a row here can copy an existing step and sit after it,
-- and that is all. It cannot invent a track, an anchor, a channel or a
-- sequence, so every custom step is a shape the engine already knows how to
-- send.
--
-- WHY the wait and the on/off switch are NOT here: a custom step gets a
-- `sequence_step_timing` row keyed on its own `step_key`, exactly like a
-- built-in one. One grain, one table, one read in the tick — and the retime
-- and switch-off paths that already exist work on a duplicate for free.
--
-- WHY the words are not here either: duplicating copies the source's resolved
-- text into `message_overrides` under the copy's own keys
-- (`email.<ns>.<step_key>.<leaf>`), so a duplicate starts as a real, editable
-- copy of what the original says today rather than a pointer to it. Editing
-- the original afterwards must not silently rewrite the copy.
create table if not exists sequence_custom_steps (
  -- `<source>__copyN`, unique within the sequence. Doubles as the copy's key
  -- segment in the message catalog, so it must stay URL- and key-safe.
  step_key    text        not null,
  sequence_id text        not null,
  -- The built-in step whose SHAPE this borrows: which paragraphs it has, whose
  -- voice it goes out in, which namespace its copy lives under. Not a
  -- reference to its words — those were copied at creation.
  source_step_key text    not null,
  -- The step it sits after, so the funnel reads in the order it sends.
  after_step_key  text    not null,
  created_at  timestamptz not null default now(),
  created_by  text,
  primary key (sequence_id, step_key)
);

comment on table sequence_custom_steps is
  'A duplicated funnel touch, created from /flows. Injected into the sequence by the pure lib/flows/customSteps.ts::applyCustomSteps, which also raises that sequence''s touch caps so an added step is not created and then silently capped. Its wait and its on/off switch live in sequence_step_timing under the same step_key; its words live in message_overrides under email.<ns>.<step_key>.<leaf>.';

alter table sequence_custom_steps enable row level security;

-- Reads under the user's JWT, same allow-list gate every staff-facing table
-- uses. Writes go through the service role in app/api/flows, which is where
-- the "does the source step exist" validation lives.
drop policy if exists "allowlisted read sequence_custom_steps" on sequence_custom_steps;
create policy "allowlisted read sequence_custom_steps" on sequence_custom_steps
  for select to authenticated
  using (public.is_email_allowed());
