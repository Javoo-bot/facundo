-- Durable effects outbox: side-effects that were best-effort inline (payout
-- retries, Shopify write-back, client notify) get a persisted row + a retry
-- schedule, drained by a cron. A permanently-failed ('dead') effect surfaces in
-- the CX hub instead of being silently swallowed.

create table if not exists outbox (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,                 -- 'payout' | 'shopify_writeback' | 'notify_client'
  payload         jsonb not null default '{}',
  order_id        uuid references orders(id) on delete set null,
  status          text not null default 'pending' check (status in ('pending', 'done', 'dead')),
  attempts        int not null default 0,
  max_attempts    int not null default 6,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  dedupe_key      text,                          -- one LIVE effect per key (partial unique below)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists outbox_due_idx on outbox (status, next_attempt_at);
-- Idempotency: at most one PENDING effect per dedupe_key (done/dead don't block a re-enqueue).
create unique index if not exists outbox_dedupe_pending_uidx
  on outbox (dedupe_key) where status = 'pending' and dedupe_key is not null;

-- Staff read (surface dead effects in the CX hub); writes are service-role-only.
alter table outbox enable row level security;
create policy "allowlisted read outbox" on outbox
  for select to authenticated using (public.is_email_allowed());
