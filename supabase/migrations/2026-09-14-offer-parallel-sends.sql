-- Offer fan-out: allow the wave engine to keep more than one live florist
-- offer open per order. Default 1 preserves the original one-at-a-time funnel.
-- Raising this trades lower placement latency for a higher chance that several
-- florists see the same order before one accepts; the accept path remains the
-- single source of truth for who actually wins.
alter table app_settings
  add column if not exists offer_parallel_sends integer not null default 1;

comment on column app_settings.offer_parallel_sends is
  'Maximum number of live sent/opened offers the wave engine may keep open per order in auto mode. 1 = sequential one-at-a-time funnel. Higher values send to multiple ranked candidates in parallel while still respecting offer expiry, accept CAS, max waves and refill/escalation guards.';
