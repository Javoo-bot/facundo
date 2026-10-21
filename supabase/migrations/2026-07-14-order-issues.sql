-- Structured per-stage issues on an order. A florist (via the app) or CX opens
-- an issue; CX resolves it. Writes go through the service-role client (routes),
-- so RLS is staff-read-only, mirroring the phase0 order tables.

create table if not exists order_issues (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id) on delete cascade,
  assignment_id     uuid references order_assignments(id) on delete set null,
  type              text not null check (type in (
                      'missing_ingredient','wrong_address','out_of_range',
                      'recipient_unavailable','damaged_wrong_recipient','other')),
  detail            text,
  stage             text,                         -- display stage the issue was raised at
  status            text not null default 'open' check (status in ('open','resolved')),
  resolution        text,
  resolution_action text check (resolution_action in (
                      'substitute','reassign','redeliver','clawback','cancel','dismiss')),
  created_by        text,                         -- florist email or CX email or 'system'
  resolved_by       text,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);
create index if not exists order_issues_order_idx on order_issues(order_id, status);

-- RLS: staff read via the allow-list; writes are service-role-only (no write policy).
alter table order_issues enable row level security;
create policy "allowlisted read order_issues" on order_issues
  for select to authenticated using (public.is_email_allowed());
