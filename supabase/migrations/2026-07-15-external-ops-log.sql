-- Feature 1: a safeguard toggle for Shopify write-backs (so we can run against a
-- live shop while testing without mutating real orders) + a uniform log of every
-- call to an external service (Shopify, Airwallex, Resend), inbound and outbound.

-- 1. Safeguard: when false, writeBackStatus records the intent but does NOT hit
--    Shopify. Defaults FALSE (safe while testing) — enable it deliberately for prod.
alter table app_settings add column if not exists shopify_writeback_enabled boolean not null default false;

-- 2. External-operations log. One row per call to an external service. `direction`
--    'out' = we called them (Shopify write, Airwallex issue/close/balance, Resend
--    send), 'in' = they called us (Shopify webhook). `ok` is null while attempted/
--    unknown, true/false once resolved; `skipped` marks a call the safeguard blocked.
create table if not exists external_ops (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,                       -- 'shopify' | 'airwallex' | 'resend'
  operation    text not null,                       -- 'writeback_status' | 'issue_card' | 'close_card' | 'wallet_balance' | 'send_email' | 'webhook_order' ...
  direction    text not null default 'out' check (direction in ('in', 'out')),
  order_id     uuid,                                -- our internal order id when known
  ref          text,                                -- provider/order ref (shopify order id, provider_ref, message id)
  ok           boolean,                             -- null = attempted/unknown; true/false = outcome
  skipped      boolean not null default false,      -- blocked by a safeguard (e.g. writeback disabled)
  status_code  integer,
  duration_ms  integer,
  error        text,
  meta         jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists external_ops_created_idx on external_ops (created_at desc);
create index if not exists external_ops_order_idx on external_ops (order_id);
create index if not exists external_ops_provider_idx on external_ops (provider, created_at desc);

alter table external_ops enable row level security;
-- Staff read only (same allow-list model as every other table); writes are
-- service-role only (the log is written from server code / the worker).
drop policy if exists "allowlisted read external_ops" on external_ops;
create policy "allowlisted read external_ops" on external_ops
  for select to authenticated using (public.is_email_allowed());
