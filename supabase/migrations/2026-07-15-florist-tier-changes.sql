-- Sprint 3 (onboarding rigor): audit trail for manual trust_tier changes made via
-- POST /api/florists/operational. Additive; follows the RLS pattern of every prior
-- table (staff read via is_email_allowed(); writes are service-role-only).

create table if not exists florist_tier_changes (
  id          uuid primary key default gen_random_uuid(),
  florist_id  uuid not null references florists(id) on delete cascade,
  from_tier   text,
  to_tier     text,
  changed_by  text,
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists florist_tier_changes_florist_idx on florist_tier_changes(florist_id);

alter table florist_tier_changes enable row level security;
create policy "allowlisted read florist_tier_changes" on florist_tier_changes
  for select to authenticated using (public.is_email_allowed());
