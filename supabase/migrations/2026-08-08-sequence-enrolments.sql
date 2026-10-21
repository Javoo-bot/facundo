-- Multi-touch outreach state: one row per florist per sequence run.
--
-- WHY a new table rather than new `outbox` effect kinds: `outbox.next_attempt_at`
-- is a RETRY clock. Parking a day-7 email there would overload `pending` to mean
-- both "deliberately due later" and "failed, try again", put thousands of
-- not-actually-due rows in front of every drain query, and — the real problem —
-- there is no way to CANCEL an outbox effect. The whole point of this funnel is
-- that a single click abandons the remaining cold touches, so cancellation is
-- the central operation, not an edge case. Scheduling and delivery-retry are
-- different problems; this table owns the schedule, and lib/email.ts /
-- lib/sms.ts already own delivery (they never throw and log every outcome).
--
-- The funnel's SHAPE (which steps, what spacing, which channels, whose voice)
-- lives in dashboard/lib/sequences/definitions.ts and its arithmetic in
-- schedule.ts — both pure and unit-tested. This table is only the state.
create table if not exists sequence_enrolments (
  id             uuid primary key default gen_random_uuid(),
  florist_id     uuid not null references florists(id) on delete cascade,
  sequence_id    text not null,               -- 'recruit_cold' | 'cold_offer_followup'
  -- cold_offer_followup only: the order whose offer we are following up on.
  order_id       uuid references orders(id) on delete set null,
  assignment_id  uuid references order_assignments(id) on delete set null,
  status         text not null default 'active'
                   check (status in ('active','paused','converted','stopped','exhausted')),
  track          text not null default 'cold' check (track in ('cold','reengage')),
  step_index     integer not null default 0,
  next_action_at timestamptz not null default now(),
  engaged_at     timestamptz,
  last_touch_at  timestamptz,
  touches_email  integer not null default 0,
  touches_sms    integer not null default 0,
  -- The enrolment that preempted this one (an order offer pausing a recruiting
  -- run). Null while running normally.
  paused_by      uuid references sequence_enrolments(id) on delete set null,
  stop_reason    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- At most ONE live run per (florist, sequence). Makes enrolment idempotent
-- under a double-clicked staff action or two overlapping ticks — the same
-- partial-unique-index trick `order_approvals.dedupe_key` uses. Terminal rows
-- are excluded so a florist can be re-enrolled next season without deleting
-- their history.
create unique index if not exists sequence_enrolments_one_live
  on sequence_enrolments (florist_id, sequence_id)
  where status in ('active','paused');

-- The tick's only query: what is due right now.
create index if not exists sequence_enrolments_due
  on sequence_enrolments (next_action_at)
  where status = 'active';

create index if not exists sequence_enrolments_florist
  on sequence_enrolments (florist_id, created_at desc);

comment on table sequence_enrolments is
  'One florist''s run through one outreach funnel. Advanced by lib/sequences/tick.ts on the per-minute cron, which delegates every decision to the pure lib/sequences/schedule.ts::nextDecision. The funnel definition itself is code (lib/sequences/definitions.ts), not rows.';

comment on column sequence_enrolments.next_action_at is
  'When the tick should next look at this row. Advanced under a CAS on this exact value (see lib/sequences/tick.ts) so two overlapping ticks cannot both send the same touch — the same discipline lib/waves.ts uses on offer_expires_at.';

comment on column sequence_enrolments.engaged_at is
  'First click on any link, any channel. Written by lib/sequences/engagement.ts::recordEngagement from the Resend webhook and the short-link redirect — NOT from the tick. It has to be prompt: a florist who clicks at 08:59 must not get the "just following up" email the 09:00 tick was about to send. Idempotent, because corporate link scanners click every URL in an email.';

comment on column sequence_enrolments.paused_by is
  'An order offer PREEMPTS recruiting. Offering an order pauses that florist''s recruiting run and points this at the preempting enrolment; if the order goes elsewhere, the recruiting run resumes at the same step_index rather than restarting.';

comment on column sequence_enrolments.stop_reason is
  'Why the run ended: joined | opted_out | replied | exhausted | cap_cold | cap_email | bounced | staff. ''exhausted'' is the normal end — the prospect passes to long-term nurture rather than being marked a failure.';

alter table sequence_enrolments enable row level security;

-- Staff read for the monitoring UI; every write goes through the service role
-- (the tick and the enrol helpers), same shape as `communications`.
create policy "allowlisted read sequence_enrolments" on sequence_enrolments
  for select to authenticated
  using (public.is_email_allowed());

-- Settings for the engine. It ships DARK: sequence_enabled defaults false, so
-- merging this migration cannot start emailing anybody.
alter table app_settings
  add column if not exists sequence_enabled          boolean not null default false,
  add column if not exists sequence_min_gap_hours    integer not null default 48,
  add column if not exists sequence_daily_send_cap   integer not null default 200;

comment on column app_settings.sequence_enabled is
  'Master switch for the outreach funnel (lib/sequences/tick.ts). Defaults FALSE — the engine ships dark and is turned on deliberately, per the same fail-closed reasoning as the SMS toggles.';

comment on column app_settings.sequence_daily_send_cap is
  'Blast radius. A bug that enrols every discovered florist at once would otherwise torch the sending domain in a single tick; the tick counts today''s sends and stops at this number.';
