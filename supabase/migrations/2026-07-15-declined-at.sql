-- Sprint 4 (feedback loop): capture when an offer was declined, not just that it
-- was. order_assignments already has assigned_at/sent_at/opened_at/accepted_at/
-- delivered_at timestamps for every other transition — declined_at was missing.
-- Backfills nothing (historical declines have no reliable decline instant), so it
-- stays null for rows declined before this migration lands.
alter table order_assignments add column if not exists declined_at timestamptz;
