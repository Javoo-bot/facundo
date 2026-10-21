create table if not exists payment_events (
  id         uuid primary key default gen_random_uuid(),
  payout_id  uuid references payouts(id) on delete set null,
  type       text not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);
alter table payment_events enable row level security;
create policy "allowlisted read payment_events" on payment_events for select to authenticated using (public.is_email_allowed());
