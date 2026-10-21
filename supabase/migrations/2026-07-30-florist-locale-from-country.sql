-- Backfill florists.locale from the florist's city country, for florists that
-- don't have a locale yet. Going forward the ingest sets this at creation
-- (ingest/main.py + ingest-worker/src/workflow.ts via region_to_locale /
-- regionToLocale); this one-time pass localizes the florists already in the table.
--
-- Mirrors that ingest map (ES → 'es', FR → 'fr', IT → 'it', DE → 'de'). English
-- and any unmapped country is the fallback: those florists stay NULL, which
-- resolves to EN at read time (dashboard/lib/i18n/index.ts::resolveFloristLocale),
-- so we don't write a redundant explicit 'en'.
--
-- `locale is null` preserves every manual choice (self-service picker or the staff
-- per-florist control) — a florist who already picked a language is untouched.
-- Idempotent and safe to re-run.
--
-- cities.country is stored as ISO alpha-2 (e.g. 'ES', 'US'); the CASE also covers
-- the common full-name forms in case any city was seeded that way.
update florists f
set locale = case
    when upper(c.country) in ('ES', 'SPAIN', 'ESPANA', 'ESPAÑA')   then 'es'
    when upper(c.country) in ('FR', 'FRANCE')                      then 'fr'
    when upper(c.country) in ('IT', 'ITALY', 'ITALIA')             then 'it'
    when upper(c.country) in ('DE', 'GERMANY', 'DEUTSCHLAND')      then 'de'
  end
from cities c
where f.city_id = c.id
  and f.locale is null
  and f.deleted_at is null
  and upper(c.country) in (
    'ES', 'SPAIN', 'ESPANA', 'ESPAÑA',
    'FR', 'FRANCE',
    'IT', 'ITALY', 'ITALIA',
    'DE', 'GERMANY', 'DEUTSCHLAND'
  );
