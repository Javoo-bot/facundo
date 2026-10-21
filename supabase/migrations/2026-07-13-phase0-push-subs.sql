create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  florist_id uuid not null references florists(id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
create policy "florist reads own push subs" on push_subscriptions for select to authenticated
  using (florist_id = public.current_florist_id());
