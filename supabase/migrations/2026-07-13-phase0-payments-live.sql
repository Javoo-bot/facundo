-- Phase 0 — Plan 5: payments live toggle.
-- Fail-closed: defaults false → LedgerRail (records intent, issues no real card).
-- Flip to true only once Airwallex Issuing is enabled for the entity.
alter table app_settings add column if not exists payments_live boolean not null default false;
