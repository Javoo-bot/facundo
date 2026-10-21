-- Pipeline control panel + Engagement CRM.
-- One lifecycle_stage axis on florists + notes/meetings tables. Additive + idempotent.

-- 1. lifecycle_stage column (default 'found'; check-constrained to the 7 stages).
alter table florists
  add column if not exists lifecycle_stage text not null default 'found';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'florists_lifecycle_stage_check'
  ) then
    alter table florists add constraint florists_lifecycle_stage_check
      check (lifecycle_stage in
        ('found','targeted','contacted','engaged','onboarding','production','lost'));
  end if;
end $$;

-- 2. Backfill: a florist with a prior *sent* reach-out is at least 'contacted'.
--    Only bumps rows still at the default 'found' — never downgrades.
update florists f set lifecycle_stage = 'contacted'
where f.lifecycle_stage = 'found'
  and exists (select 1 from outreach o where o.florist_id = f.id and o.status = 'sent');

-- 3. Notes — free-text, appended to the florist activity timeline.
create table if not exists florist_notes (
  id          uuid primary key default gen_random_uuid(),
  florist_id  uuid not null references florists(id) on delete cascade,
  author      text,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists florist_notes_florist_id_idx on florist_notes(florist_id);
alter table florist_notes enable row level security;
-- Select-only for allow-listed users; writes via service-role routes only
-- (same pattern as outreach/ingest_jobs — NO insert/update policy).
drop policy if exists "allowlisted read florist_notes" on florist_notes;
create policy "allowlisted read florist_notes" on florist_notes
  for select to authenticated using (public.is_email_allowed());

-- 4. Meetings / follow-ups.
create table if not exists florist_meetings (
  id                uuid primary key default gen_random_uuid(),
  florist_id        uuid not null references florists(id) on delete cascade,
  title             text,
  meeting_at        timestamptz not null,
  outcome           text,
  next_follow_up_at timestamptz,
  created_by        text,
  created_at        timestamptz not null default now()
);
create index if not exists florist_meetings_florist_id_idx on florist_meetings(florist_id);
alter table florist_meetings enable row level security;
drop policy if exists "allowlisted read florist_meetings" on florist_meetings;
create policy "allowlisted read florist_meetings" on florist_meetings
  for select to authenticated using (public.is_email_allowed());
