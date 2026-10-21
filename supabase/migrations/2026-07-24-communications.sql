-- Communications hub, Workstream A: the unified message-shaped log. One row
-- per outbound message (email or push) across every audience (florist/client/
-- cx/staff), WITH the actual subject/body content — the gap external_ops (call
-- metadata only) and outreach (recruiting-only) both leave. Backbone for the
-- /communications view, the per-order "Communications" section, and the
-- per-florist comms list (Workstream B). Written from lib/communications.ts
-- (service-role only, mirroring the phase0 external_ops / order_issues RLS
-- shape); external_ops logging is untouched and stays the call-level audit.

create table if not exists communications (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  channel              text not null check (channel in ('email', 'push')),
  audience             text not null check (audience in ('florist', 'client', 'cx', 'staff')),
  kind                 text not null,                 -- 'offer' | 'offer_push' | 'client_assigned' |
                                                       -- 'client_on_the_way' | 'client_delivered' |
                                                       -- 'cx_alert' | 'cx_alert_push' | 'issue_to_cx' |
                                                       -- 'issue_to_florist' | 'issue_push' | 'recruiting' | 'test'
  order_id             uuid references orders(id) on delete set null,
  florist_id           uuid references florists(id) on delete set null,
  assignment_id        uuid,                          -- denormalized id, no FK (log row must survive assignment churn)
  issue_id             uuid,                          -- denormalized id, no FK (log row must survive issue churn)
  to_address           text,                          -- email address or masked push endpoint; null for a batch push
  subject              text,                          -- null for push
  body                 text,                          -- the actual content sent — the gap this table closes
  test_mode            boolean not null,               -- was this routed to the test sink
  status               text not null check (status in ('sent', 'failed', 'skipped')),
  provider             text not null,                 -- 'resend' | 'web-push'
  provider_message_id  text,
  error                text,
  actor                text                            -- who/what triggered the send (email or 'system')
);
create index if not exists communications_order_idx on communications(order_id, created_at desc);
create index if not exists communications_created_idx on communications(created_at desc);

alter table communications enable row level security;
-- Staff read all (same allow-list model as every other table); a florist reads
-- only messages addressed TO them — florist_id ownership AND audience='florist'
-- (mirrors order_issues/issue_messages). The audience guard is load-bearing: a
-- client/cx row can carry the assigned florist_id (e.g. the customer's delivered
-- notice), and without it a florist could read that client-facing body/PII.
-- Writes are service-role only — no insert/update/delete policy.
create policy "allowlisted read communications" on communications
  for select to authenticated using (public.is_email_allowed());
create policy "florist reads own communications" on communications
  for select to authenticated
  using (florist_id = public.current_florist_id() and audience = 'florist');
