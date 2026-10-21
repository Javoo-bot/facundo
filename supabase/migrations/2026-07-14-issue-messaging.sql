-- Two-way florist ↔ CX messaging on order issues. Turns each order_issues row
-- into a conversation: florist and CX post issue_messages back and forth, with
-- unread flags for badges and email notifications wired in the routes.

-- 1. Thread messages ---------------------------------------------------------
create table if not exists issue_messages (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references order_issues(id) on delete cascade,
  order_id      uuid not null references orders(id) on delete cascade,
  -- Denormalized so the florist RLS policy is a simple assignment-ownership check.
  assignment_id uuid references order_assignments(id) on delete set null,
  author_role   text not null check (author_role in ('florist', 'cx', 'system')),
  author        text,            -- email of the poster (or 'system')
  body          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists issue_messages_issue_idx on issue_messages(issue_id, created_at);

-- 2. Unread flags on the issue (drive the badges). Set when the OTHER side
--    posts; cleared when this side opens the thread. -------------------------
alter table order_issues add column if not exists florist_unread boolean not null default false;
alter table order_issues add column if not exists cx_unread boolean not null default false;

-- 3. CX / ops inbox address for issue emails (settings-editable, mirrors test_email).
alter table app_settings add column if not exists cx_email text;

-- 4. RLS -------------------------------------------------------------------
-- Florists can now read their own issues (previously staff-read-only) + the
-- thread. Writes stay service-role-only (routes ownership-check + insert).
create policy "florist reads own order_issues" on order_issues
  for select to authenticated
  using (assignment_id in (select id from order_assignments where florist_id = public.current_florist_id()));

alter table issue_messages enable row level security;
create policy "allowlisted read issue_messages" on issue_messages
  for select to authenticated using (public.is_email_allowed());
create policy "florist reads own issue_messages" on issue_messages
  for select to authenticated
  using (assignment_id in (select id from order_assignments where florist_id = public.current_florist_id()));
