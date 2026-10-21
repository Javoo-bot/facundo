-- Migration: enforce the demo allow-list at the database (RLS), not just in the app.
-- Safe to run once on a project already created from the original schema.sql.
-- Replaces the permissive `using (true)` read policies with an allow-list check.

-- 1. Drop the old permissive policies.
drop policy if exists "authed read cities"   on cities;
drop policy if exists "authed read florists" on florists;

-- 2. Allow-list table (security-critical source of truth for read access).
create table if not exists allowed_emails (
  email text primary key
);
alter table allowed_emails enable row level security;
-- No policies → unreadable/unwritable by anon + authenticated; service role only.

-- 3. Allow-list check. SECURITY DEFINER so the policy can read allowed_emails
--    even though the caller has no SELECT grant on it.
create or replace function public.is_email_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from allowed_emails
    where email = (auth.jwt() ->> 'email')
  );
$$;

-- 4. New allow-list-gated read policies.
create policy "allowlisted read cities"   on cities   for select to authenticated using (public.is_email_allowed());
create policy "allowlisted read florists" on florists for select to authenticated using (public.is_email_allowed());

-- 5. Seed the allow-list (keep in sync with the dashboard ALLOWED_EMAILS env var).
insert into allowed_emails (email) values ('user@example.com')
on conflict (email) do nothing;
