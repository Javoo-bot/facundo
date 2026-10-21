-- Feature 2: semi-automatic / step-authorization mode.
--
-- `workflow_mode` was decorative (stored, never gated behavior). Repurpose it as
-- the automation level: 'manual' (nothing auto-fires; humans drive each step),
-- 'semi' (the system proposes each step, a human approves/edits/skips before it
-- executes), 'auto' (the loop runs unattended). Migrate the old values in place.

alter table app_settings drop constraint if exists app_settings_workflow_mode_check;
update app_settings set workflow_mode = case workflow_mode
  when 'test' then 'manual'
  when 'step' then 'semi'
  when 'auto' then 'auto'
  else 'manual' end;
alter table app_settings alter column workflow_mode set default 'manual';
alter table app_settings add constraint app_settings_workflow_mode_check
  check (workflow_mode in ('manual', 'semi', 'auto'));

-- Step-mode approvals. In 'semi', instead of auto-sending an offer the wave engine
-- files a pending approval here; a human approves (send), edits (send with changes),
-- or skips (try the next candidate). Photo-proof approval is NOT modelled here — it
-- reuses the existing held-payout gate (payouts.status='held' + approve/reject).
--
-- Mirrors the held-payout pattern (a status that sits deliberately until a person
-- acts, with decided_by/decided_at), not the blind-retry outbox.
create table if not exists order_approvals (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  assignment_id uuid references order_assignments(id) on delete cascade,  -- the candidate to offer
  kind          text not null default 'offer' check (kind in ('offer')),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'skipped')),
  draft_subject text,                              -- snapshot of the offer draft (editable at approval)
  draft_body    text,
  created_by    text not null default 'system',
  decided_by    text,
  decided_at    timestamptz,
  reason        text,
  created_at    timestamptz not null default now()
);
create index if not exists order_approvals_order_idx on order_approvals (order_id, status);
-- At most one pending approval per order at a time — stops overlapping wave ticks
-- from filing duplicate offer approvals.
create unique index if not exists order_approvals_pending_uidx on order_approvals (order_id) where status = 'pending';

alter table order_approvals enable row level security;
drop policy if exists "allowlisted read order_approvals" on order_approvals;
create policy "allowlisted read order_approvals" on order_approvals
  for select to authenticated using (public.is_email_allowed());
