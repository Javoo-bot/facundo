-- Client-facing FLQ notifications audit (staff read via is_email_allowed(); writes are
-- service-role-only). One row per (order, kind) enforces idempotency: a redelivered webhook
-- or a repeated accept never double-sends, and it never overlaps Shopify's own confirmation.
create table if not exists client_comms (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  kind       text not null check (kind in ('assigned', 'delivered')),
  sent_at    timestamptz not null default now(),
  test_mode  boolean not null,
  unique (order_id, kind)
);
alter table client_comms enable row level security;
create policy "allowlisted read client_comms" on client_comms for select to authenticated using (public.is_email_allowed());
