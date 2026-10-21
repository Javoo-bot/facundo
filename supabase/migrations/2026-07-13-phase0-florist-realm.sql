-- Florist identity: maps a Supabase auth user to a florist row. Populated on first login by
-- matching the auth email to florists.email (service-role, in /api/florist/link).
create table if not exists florist_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  florist_id uuid not null references florists(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists florist_users_florist_idx on florist_users(florist_id);
alter table florist_users enable row level security;
create policy "florist reads own mapping" on florist_users for select to authenticated
  using (user_id = auth.uid());

-- Helper: the florist_id for the current auth user (security definer, stable).
create or replace function public.current_florist_id() returns uuid language sql stable security definer as $$
  select florist_id from florist_users where user_id = auth.uid();
$$;

-- Additional PERMISSIVE read policies — a florist sees only their own rows. Staff keep their
-- existing is_email_allowed() policies; the two OR together.
create policy "florist reads own assignments" on order_assignments for select to authenticated
  using (florist_id = public.current_florist_id());
create policy "florist reads own orders" on orders for select to authenticated
  using (id in (select order_id from order_assignments where florist_id = public.current_florist_id()));
create policy "florist reads own delivery_events" on delivery_events for select to authenticated
  using (assignment_id in (select id from order_assignments where florist_id = public.current_florist_id()));
create policy "florist reads own payouts" on payouts for select to authenticated
  using (assignment_id in (select id from order_assignments where florist_id = public.current_florist_id()));
