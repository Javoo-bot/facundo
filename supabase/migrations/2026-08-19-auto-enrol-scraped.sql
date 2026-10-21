-- Auto-enrol freshly scraped shops into the recruiting funnel — behind an
-- opt-in switch. See dashboard/lib/sequences/autoEnrol.ts (the pure
-- eligibility rule) and lib/sequences/reconcile.ts::enrolNewlyScrapedShops
-- (the sweep the tick runs).
--
-- Why: ingest-on-empty (ingest-worker/src/autoIngest.ts) scrapes an
-- uncovered delivery area automatically, but until now NOTHING contacted the
-- shops it found — they sat at lifecycle_stage='found' until a human noticed
-- the new city on /discovery and pressed Send. The scrape was automatic; the
-- introduction was not.
--
-- Ships DARK, same reasoning as sequence_enabled: merging this migration
-- cannot start emailing anybody. Even when on, the sweep is bounded per tick,
-- only looks at shops ingested in the last AUTO_ENROL_LOOKBACK_DAYS, and still
-- sits under sequence_enabled and the daily send cap.
alter table app_settings
  add column if not exists sequence_auto_enrol_scraped boolean not null default false;

comment on column app_settings.sequence_auto_enrol_scraped is
  'Opt-in: newly ingested shops (lifecycle_stage=found, with an email, ingested within the lookback window) are enrolled in recruit_cold automatically by the sequence tick. FALSE by default. No effect unless sequence_enabled is also on; the daily send cap still applies.';
