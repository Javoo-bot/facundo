// Phone-number resolution for florist SMS. Pure, no I/O, and imports only
// relative/package paths (no "@/" aliases) so plain `node --test` can reach
// it — same constraint as lib/offerEmailContent.ts and lib/communicationsRow.ts.
import parsePhoneNumberFromString, { type CountryCode } from "libphonenumber-js";
// Default import, not `import * as countries` (which ingest-worker's twin
// uses under esbuild bundling): under plain `node --test`'s native ESM
// loader, i18n-iso-countries' CJS→ESM interop only reliably exposes a
// `default` — its re-export chain (entry-node.js -> index.js) defeats
// cjs-module-lexer's static named-export detection.
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json" with { type: "json" };

countries.registerLocale(enLocale);

/** The florist columns this module reads. A structural subset so callers can
 * pass whatever `.select(...)` projection they already fetched. */
export interface FloristPhoneFields {
  phone_mobile?: string | null;
  phone_web?: string | null;
  phone_maps?: string | null;
}

/** Resolve a free-text `country` (as stored in `cities.country` — whatever
 * followed the comma in the ingest CLI's `--city "Country, City"` argument,
 * see lib/cityList.ts::parseCityList) to an ISO-3166-1 alpha-2 region code
 * that libphonenumber-js understands (e.g. "Spain" -> "ES", "US" -> "US",
 * "United States" -> "US", "UK" -> "GB").
 *
 * Mirrors ingest-worker/src/phones.ts::countryToRegion exactly (same
 * library, same alpha-2 → alpha-3 → English-name lookup order) — this is
 * the dashboard-side twin of that function, not a reinvention.
 *
 * Returns null when it can't be resolved. `resolveFloristSmsPhone` still
 * works without a region for numbers that already start with "+<country
 * code>" — only region-less local/national numbers are left unresolved
 * (and safely dropped, not guessed at) in that case. */
export function countryToRegion(country: string | null): string | null {
  if (!country) return null;
  const trimmed = country.trim();
  if (!trimmed) return null;

  // Exact alpha-2 / alpha-3 code match first (cheap, unambiguous).
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && countries.isValid(upper)) {
    return upper;
  }
  if (upper.length === 3 && countries.isValid(upper)) {
    const alpha2 = countries.alpha3ToAlpha2(upper);
    if (alpha2) return alpha2;
  }

  // Name match ("Spain", "United States", "UK", and other common variants
  // i18n-iso-countries knows about).
  const byName = countries.getAlpha2Code(trimmed, "en");
  if (byName) return byName;

  return null;
}

/** One candidate → E.164, or null if it can't be parsed with confidence.
 * `defaultRegion` is the ISO-3166-1 alpha-2 country of the city the florist
 * was ingested under; it is only consulted for numbers NOT already in
 * international (+…) form. */
function toE164(raw: string | null | undefined, defaultRegion: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const region = defaultRegion ? (defaultRegion.trim().toUpperCase() as CountryCode) : undefined;
  const parsed = parsePhoneNumberFromString(raw, region);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164, e.g. "+34612345678"
}

/** The number to text a florist at, or null when we don't have a usable one.
 *
 * Preference order, best evidence first:
 *
 *   1. `phone_mobile` — the florist typed this into the join form under a label
 *      that says we will text it about orders, and it was validated to E.164 at
 *      write time. That is the only number in the row anyone actually confirmed
 *      is reachable, so it wins outright.
 *   2. `phone_web` — scraped from the florist's own site, usually the number
 *      they publish for customers.
 *   3. `phone_maps` — the Maps listing.
 *
 * Each falls through when missing OR unparseable. 2 and 3 are scraped and
 * unverified by design (see the spec): staff correct a bad number through the
 * florist-edit-details panel, exactly as they already do for a bad email.
 *
 * Deliberately does NOT filter out landlines — SMS-capability cannot be
 * detected reliably from the number alone, and Telnyx reports the real
 * failure, which is more honest than us guessing. */
export function resolveFloristSmsPhone(
  florist: FloristPhoneFields,
  defaultRegion: string | null
): string | null {
  return (
    toE164(florist.phone_mobile, defaultRegion) ??
    toE164(florist.phone_web, defaultRegion) ??
    toE164(florist.phone_maps, defaultRegion)
  );
}

/** One free-text phone → E.164, or null. Exported for the join form's
 * server-side validation (lib/floristAccept.ts), which must reject a number it
 * can't normalise rather than storing something we can never text. */
export function normalizePhone(raw: string | null | undefined, defaultRegion: string | null): string | null {
  return toE164(raw, defaultRegion);
}
