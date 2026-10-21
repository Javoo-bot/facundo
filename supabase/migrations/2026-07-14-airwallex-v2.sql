-- Airwallex v2 — payout lifecycle columns fed by webhooks + a webhook
-- idempotency table. Idempotent (add-column-if-not-exists / create-if-not-exists).

alter table payouts add column if not exists card_status    text;        -- ACTIVE | USED | CLOSED | EXPIRED ...
alter table payouts add column if not exists expires_at     timestamptz; -- card expiry
alter table payouts add column if not exists spent_amount   numeric;     -- from authorization/clearing webhooks
alter table payouts add column if not exists settled_at     timestamptz; -- when the clearing webhook landed
alter table payouts add column if not exists dispute_status text;        -- SUBMITTED | IN_PROGRESS | ACCEPTED | WON | LOST ...
alter table payouts add column if not exists last_txn_id    text;        -- Airwallex transaction id (for deep-links)

-- Webhook idempotency: the Airwallex event id is the primary key, so a redelivered
-- event is a no-op (unique-violation on insert → we return 200 without reprocessing).
create table if not exists airwallex_events (
  id          text primary key,
  type        text,
  received_at timestamptz not null default now()
);
alter table airwallex_events enable row level security;
create policy "allowlisted read airwallex_events"
  on airwallex_events for select to authenticated using (public.is_email_allowed());
