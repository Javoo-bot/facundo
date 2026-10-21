-- Portuguese joins the supported-locale set (dashboard/lib/i18n/locales.ts,
-- ingest/locales.py, ingest-worker/src/locale.ts — PT and BR both → 'pt').
-- Going forward the ingest sets this at creation; this pass localizes the
-- Portuguese/Brazilian florists already in the table, exactly as
-- 2026-07-30-florist-locale-from-country.sql did for es/fr/it/de.
--
-- `locale is null` preserves every manual choice (self-service picker or the
-- staff per-florist control) — a florist who already picked a language is
-- untouched. Idempotent and safe to re-run.
--
-- cities.country is stored as ISO alpha-2 (e.g. 'PT', 'BR'); the CASE also
-- covers the common full-name forms in case any city was seeded that way.
update florists f
set locale = 'pt'
from cities c
where f.city_id = c.id
  and f.locale is null
  and f.deleted_at is null
  and upper(c.country) in (
    'PT', 'PORTUGAL',
    'BR', 'BRAZIL', 'BRASIL'
  );
