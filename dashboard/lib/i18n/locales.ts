// Supported locales for outbound copy (florist-facing for now; see
// dashboard/lib/i18n/index.ts for the lookup/fallback machinery). Adding a
// locale here means: add it to LOCALES, create messages/<locale>.ts (an empty
// object is a valid start — it falls back to EN per-key), and nothing else —
// callers only ever see the Locale type + resolveLocale/isLocale.

export type Locale = "en" | "fr" | "es" | "it" | "de" | "pt";

export const LOCALES: Locale[] = ["en", "fr", "es", "it", "de", "pt"];

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(x: unknown): x is Locale {
  return typeof x === "string" && (LOCALES as string[]).includes(x);
}

// alpha-2 region -> supported locale. English / any unlisted country falls
// through to null. A THIRD copy of the same map — ingest/locales.py and
// ingest-worker/src/locale.ts are the other two (separate builds, no shared
// module); keep all three in step when adding a locale to LOCALES above.
// BR maps to the same "pt" catalog as PT — the copy is written to read
// naturally in both (no "tu"/"você"-specific phrasing, no PT-only vocabulary).
//
// The Spanish-speaking Americas and AT were missing until 2026-09-16, which is
// why ~1,050 shops in those countries were being emailed in ENGLISH: the map
// was the only thing standing between a null `florists.locale` and the EN
// default. Found while diagnosing order #2000034 (see
// docs/superpowers/specs/2026-09-16-florist-locale-and-reply-failures-design.md).
// They all share one catalog each — es-ES copy reads naturally across LatAm
// here, the same call already made for BR/PT above.
//
// DELIBERATELY ABSENT: CH, BE, LU. They are multilingual, so the COUNTRY CODE
// ALONE CANNOT DECIDE — mapping CH to "fr" would send French to Zurich (221
// shops) and Basel (114). These need the shop's own address, which is the
// country-derivation work on fix/florist-country-derivation. Until that lands
// they stay null → EN, and `isUnintendedEnglish` below is what makes that
// visible instead of silent.
const REGION_TO_LOCALE: Record<string, Locale> = {
  ES: "es", FR: "fr", IT: "it", DE: "de", PT: "pt", BR: "pt",
  AT: "de",
  // Spanish-speaking Americas.
  AR: "es", BO: "es", CL: "es", CO: "es", CR: "es", CU: "es", DO: "es",
  EC: "es", GT: "es", HN: "es", MX: "es", NI: "es", PA: "es", PE: "es",
  PR: "es", PY: "es", SV: "es", UY: "es", VE: "es",
  // Business decisions confirmed 2026-09-16, not language facts: Andorra's
  // official language is Catalan (no catalog) and Spanish is the working
  // language with it; Morocco and Tunisia do business in French alongside
  // Arabic (no catalog). ~187 shops were getting English.
  AD: "es", MA: "fr", TN: "fr",
};

// Countries where English IS the right default, so resolving to EN is a
// correct outcome rather than a gap. Only consulted by `isUnintendedEnglish`
// — never by `regionToLocale`, which keeps returning null for these (we
// persist a locale only when the country implies a NON-English language).
const ENGLISH_REGIONS = new Set(["US", "GB", "IE", "AU", "NZ", "CA", "ZA", "MT"]);

/** True when `region` is a country we consider English-defaulting. */
export function regionImpliesEnglish(region: string | null | undefined): boolean {
  if (!region) return false;
  return ENGLISH_REGIONS.has(region.trim().toUpperCase());
}

/** Locale implied by an ISO-3166-1 alpha-2 region, or null when the country
 * doesn't imply a supported non-English language (null resolves to EN). */
export function regionToLocale(region: string | null | undefined): Locale | null {
  if (!region) return null;
  return REGION_TO_LOCALE[region.trim().toUpperCase()] ?? null;
}
