"""Derive a florist's UI/email locale from their country.

`region_to_locale` maps an ISO-3166-1 alpha-2 region — already resolved from the
free-text country by `phones.country_to_region` — to one of the supported florist
locales. The supported set mirrors `dashboard/lib/i18n/locales.ts`
(en/fr/es/it/de/pt) and the worker's `ingest-worker/src/locale.ts`; keep the three in
step.

A country that doesn't imply a specific supported language returns `None`, and
callers leave `florists.locale` unset. `null` resolves to English at read time
(`dashboard/lib/i18n/index.ts::resolveFloristLocale`), so we persist a locale only
when the location implies a non-English language — English florists stay null
rather than carrying a redundant explicit "en".
"""

# alpha-2 region -> supported locale. English (and any unlisted country) is the
# fallback, represented as an absent key so region_to_locale returns None.
#
# AT and the Spanish-speaking Americas were missing until 2026-09-16, which is
# why ~1,050 shops in those countries carried a null locale and were emailed in
# English (see the design doc dated that day under docs/superpowers/specs/).
#
# DELIBERATELY ABSENT: CH, BE, LU — multilingual, so the country code alone
# cannot decide. Mapping CH to "fr" would send French to Zurich and Basel.
# They need the shop's own address; until that derivation lands they stay None.
REGION_TO_LOCALE = {
    "ES": "es", "FR": "fr", "IT": "it", "DE": "de", "PT": "pt", "BR": "pt",
    "AT": "de",
    # Spanish-speaking Americas.
    "AR": "es", "BO": "es", "CL": "es", "CO": "es", "CR": "es", "CU": "es",
    "DO": "es", "EC": "es", "GT": "es", "HN": "es", "MX": "es", "NI": "es",
    "PA": "es", "PE": "es", "PR": "es", "PY": "es", "SV": "es", "UY": "es",
    "VE": "es",
    # Business decisions confirmed 2026-09-16 (see dashboard/lib/i18n/locales.ts):
    # Andorra -> Spanish, Morocco and Tunisia -> French.
    "AD": "es", "MA": "fr", "TN": "fr",
}


def region_to_locale(region: str | None) -> str | None:
    """Return the supported locale for an alpha-2 region, or None for English/
    unmapped countries (caller leaves florists.locale null → resolves to EN)."""
    if not region:
        return None
    return REGION_TO_LOCALE.get(region.strip().upper())
