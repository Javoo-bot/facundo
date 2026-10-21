-- One row per Resend delivery-lifecycle webhook event, linked back to the
-- communications row it's about. Populated by app/api/webhooks/resend/route.ts.
-- See docs/superpowers/specs/2026-08-05-statistics-and-insights-design.md.

create table email_events (
  id               uuid primary key default gen_random_uuid(),
  communication_id uuid references communications(id) on delete set null,
  event_type       text not null check (event_type in
                      ('delivered', 'opened', 'clicked', 'bounced', 'complained')),
  occurred_at      timestamptz not null default now(),
  raw              jsonb not null
);
create index email_events_comm_idx on email_events(communication_id);
create index email_events_occurred_idx on email_events(occurred_at desc);

alter table email_events enable row level security;
create policy "allowlisted read email_events" on email_events
  for select to authenticated using (public.is_email_allowed());
-- No write policy: inserts are service-role only, from the Resend webhook route
-- (which authenticates via signature, not a staff session).
