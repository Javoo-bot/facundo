-- Messages addressed to a FLORIST rather than to an order.
--
-- WHY a new table: the "Messages" tab (app/florist/(app)/messages) has until now
-- been a view over `order_issues`, and every row there is bound to an order —
-- `order_id` is NOT NULL, and the florist RLS policy scopes by
-- `assignment_id in (select id from order_assignments where florist_id = ...)`.
-- A florist who has just joined has no orders and no assignments, so a welcome
-- message cannot live there: the insert would fail the NOT NULL, and even if it
-- didn't, the row would be invisible to the very florist it addresses.
--
-- Deliberately NO title/body columns. The copy renders from the i18n catalog at
-- read time (lib/i18n + lib/messageOverrides), exactly like every other
-- florist-facing message in this product. That keeps all six locales working
-- for free, and means staff can edit the wording from the existing
-- /email-templates editor without a deploy. Storing rendered text would fork
-- the copy and freeze each message at the wording it had when it was inserted.

create table if not exists florist_messages (
  id             uuid primary key default gen_random_uuid(),
  florist_id     uuid not null references florists(id) on delete cascade,
  -- Which catalog entry to render. Extend the CHECK when adding a kind.
  kind           text not null check (kind in ('welcome')),
  florist_unread boolean not null default true,
  created_at     timestamptz not null default now(),
  read_at        timestamptz,
  -- One message per kind per florist. Makes the insert idempotent: a retried
  -- join submission, or a florist who somehow redeems twice, cannot stack up
  -- duplicate welcomes in the list.
  unique (florist_id, kind)
);

create index if not exists florist_messages_florist_idx
  on florist_messages(florist_id, florist_unread);

-- RLS mirrors order_issues exactly: the florist reads their own, staff read via
-- the allow-list, and there is no write policy at all — every write goes through
-- a route using the service-role client.
alter table florist_messages enable row level security;

create policy "florist reads own florist_messages" on florist_messages
  for select to authenticated
  using (florist_id = public.current_florist_id());

create policy "allowlisted read florist_messages" on florist_messages
  for select to authenticated
  using (public.is_email_allowed());

comment on table florist_messages is
  'Messages addressed to a florist rather than to an order (welcome note, and later any broadcast notice). Body/title are NOT stored — `kind` selects an i18n catalog entry rendered at read time, so the copy stays translated and stays editable from /email-templates. Contrast order_issues, which is always about one order.';
