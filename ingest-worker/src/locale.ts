// Derive a florist's UI/email locale from their country. Ported from
// ingest/locales.py — keep the two in step, and in step with the supported-locale
// set in dashboard/lib/i18n/locales.ts (en/fr/es/it/de/pt).
//
// `regionToLocale` maps an ISO-3166-1 alpha-2 region (already resolved from the
// free-text country by phones.countryToRegion) to a supported locale. A country
// that doesn't imply a specific supported language returns null, and the caller
// leaves florists.locale unset — null resolves to English at read time
// (dashboard/lib/i18n/index.ts::resolveFloristLocale), so we persist a locale only
// when the location implies a non-English language.

// alpha-2 region -> supported locale. English / any unlisted country falls
// through to null.
//
// AT and the Spanish-speaking Americas were missing until 2026-09-16, which is
// why ~1,050 shops in those countries carried a null locale and were emailed in
// English (see the design doc dated that day under docs/superpowers/specs/).
//
// DELIBERATELY ABSENT: CH, BE, LU — multilingual, so the country code alone
// cannot decide. Mapping CH to "fr" would send French to Zurich and Basel.
// They need the shop's own address; until that derivation lands they stay null.
const REGION_TO_LOCALE: Record<string, string> = {
  ES: "es", FR: "fr", IT: "it", DE: "de", PT: "pt", BR: "pt",
  AT: "de",
  // Spanish-speaking Americas.
  AR: "es", BO: "es", CL: "es", CO: "es", CR: "es", CU: "es", DO: "es",
  EC: "es", GT: "es", HN: "es", MX: "es", NI: "es", PA: "es", PE: "es",
  PR: "es", PY: "es", SV: "es", UY: "es", VE: "es",
  // Business decisions confirmed 2026-09-16 (see dashboard/lib/i18n/locales.ts):
  // Andorra -> Spanish, Morocco and Tunisia -> French.
  AD: "es", MA: "fr", TN: "fr",
};

export function regionToLocale(region: string | null): string | null {
  if (!region) return null;
  return REGION_TO_LOCALE[region.trim().toUpperCase()] ?? null;
}
