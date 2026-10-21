// The country a florist shop is ACTUALLY in, read from its own address.
//
// WHY THIS EXISTS: until 2026-09-16 a florist's country came from the city it
// was ingested under, never from its own address. City radii are 20 km and
// they cross borders, so this was wrong for whole populations at a time:
// 46 of Founex (CH)'s 174 shops are in France, and Basel is a three-country
// city (85 Schweiz, 18 Deutschland, 11 Frankreich). Two separate production
// failures came out of that single assumption on order #2000034 —
//
//   1. LANGUAGE. A shop in Cranves-Sales (FR) inherited CH, which maps to no
//      supported locale, so its offer email went out in English.
//   2. PHONE. The shop's local landline "04 50 00 11 22" was parsed against
//      the city's region, CH, by the Cloudflare Worker's row builder.
//      libphonenumber-js accepts that as a valid Swiss number and stored
//      "+41 45 000 11 22"; Telnyx rejected the SMS with "Invalid destination
//      number". That fix lives in ingest-worker/src/shopCountry.ts.
//
// See docs/superpowers/specs/2026-09-16-florist-locale-and-reply-failures-design.md.
//
// Relative imports only (with .ts extensions) so plain `node --test` can reach
// it — the same constraint lib/phone.ts and lib/offerEmailContent.ts carry.
import countries from "i18n-iso-countries";
import { regionToLocale, type Locale } from "./i18n/locales.ts";

// Google Maps returns the country name in the language of the scrape, so the
// column holds names in many languages at once — "Frankreich" and "France"
// both appear, as do "Schweiz"/"Switzerland", "España", "Danmark", "Polska",
// "Türkiye", "Ελλάδα", "ישראל", "Србија" and "تونس". This list is every
// language observed in the `florists.address` column as of 2026-09-16, plus
// the obvious neighbours. Adding one is free: import the JSON and list it.
import en from "i18n-iso-countries/langs/en.json" with { type: "json" };
import de from "i18n-iso-countries/langs/de.json" with { type: "json" };
import fr from "i18n-iso-countries/langs/fr.json" with { type: "json" };
import es from "i18n-iso-countries/langs/es.json" with { type: "json" };
import it from "i18n-iso-countries/langs/it.json" with { type: "json" };
import pt from "i18n-iso-countries/langs/pt.json" with { type: "json" };
import nl from "i18n-iso-countries/langs/nl.json" with { type: "json" };
import ca from "i18n-iso-countries/langs/ca.json" with { type: "json" };
import da from "i18n-iso-countries/langs/da.json" with { type: "json" };
import sv from "i18n-iso-countries/langs/sv.json" with { type: "json" };
import nb from "i18n-iso-countries/langs/nb.json" with { type: "json" };
import fi from "i18n-iso-countries/langs/fi.json" with { type: "json" };
import et from "i18n-iso-countries/langs/et.json" with { type: "json" };
import pl from "i18n-iso-countries/langs/pl.json" with { type: "json" };
import cs from "i18n-iso-countries/langs/cs.json" with { type: "json" };
import sk from "i18n-iso-countries/langs/sk.json" with { type: "json" };
import hr from "i18n-iso-countries/langs/hr.json" with { type: "json" };
import sr from "i18n-iso-countries/langs/sr.json" with { type: "json" };
import ro from "i18n-iso-countries/langs/ro.json" with { type: "json" };
import bg from "i18n-iso-countries/langs/bg.json" with { type: "json" };
import el from "i18n-iso-countries/langs/el.json" with { type: "json" };
import tr from "i18n-iso-countries/langs/tr.json" with { type: "json" };
import he from "i18n-iso-countries/langs/he.json" with { type: "json" };
import ar from "i18n-iso-countries/langs/ar.json" with { type: "json" };

const NAME_LOCALES = [en, de, fr, es, it, pt, nl, ca, da, sv, nb, fi, et,
                      pl, cs, sk, hr, sr, ro, bg, el, tr, he, ar];
for (const l of NAME_LOCALES) countries.registerLocale(l as never);

/** Casefold and strip diacritics so "España" matches "espana" and "Türkiye"
 * matches "turkiye". Leaves non-Latin scripts (Greek, Hebrew, Cyrillic,
 * Arabic) alone, which is correct — they are already exact. */
function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** normalized country name (in ANY registered language) -> alpha-2.
 *
 * Built once at module load rather than looping `getAlpha2Code` over 24
 * locales per lookup — this runs on the offer send path.
 *
 * A name claimed by two DIFFERENT countries across languages is deleted, not
 * arbitrated: an ambiguous token must resolve to null and let the caller fall
 * back, never silently pick one. Guessing is what put a French shop on a
 * Swiss country code in the first place. */
const NAME_TO_ALPHA2: Map<string, string> = (() => {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const l of NAME_LOCALES) {
    const locale = (l as { locale: string }).locale;
    const names = countries.getNames(locale) as Record<string, string | string[]>;
    for (const [alpha2, value] of Object.entries(names)) {
      for (const name of Array.isArray(value) ? value : [value]) {
        if (!name) continue;
        const key = normalize(name);
        if (!key) continue;
        const seen = index.get(key);
        if (seen && seen !== alpha2) ambiguous.add(key);
        else if (!seen) index.set(key, alpha2);
      }
    }
  }
  for (const key of ambiguous) index.delete(key);
  return index;
})();

/** How many trailing comma-separated segments to consider. The country is
 * usually last, but not always: Google hands back
 * "Example Ave, 40, Uzhhorod, Zakarpattia Oblast, Ukrajina, 88000" with the
 * postcode AFTER the country. Three covers every real shape observed without
 * reaching far enough back to start matching street or city names. */
const TAIL_SEGMENTS = 3;

/** The shop's ISO-3166-1 alpha-2 country, read from the tail of its address,
 * or null when the address does not name one.
 *
 * NULL IS A FIRST-CLASS ANSWER and callers must keep their existing fallback:
 * roughly 5% of rows genuinely have no country in the address at all
 * ("Carrer del Carme 10, Girona", "None, Boston, MA 02122",
 * "Rue de la Gare 3, 88000"). Returning a guess for those would be strictly
 * worse than returning nothing. */
export function countryFromAddress(address: string | null | undefined): string | null {
  if (!address || !address.trim()) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const tail = parts.slice(-TAIL_SEGMENTS).reverse();
  for (const segment of tail) {
    const hit = NAME_TO_ALPHA2.get(normalize(segment));
    if (hit) return hit;
  }
  return null;
}

// Swiss postcodes are allocated by region, and the regions are linguistic.
// Measured against all 1,061 Swiss-address shops in production on 2026-09-16:
// 243 fall in the French ranges, 818 in the German ones, and ZERO in the
// Italian ones — so the Ticino arm below is correctness-for-free rather than
// something the current data exercises.
//
// Boundaries are deliberately coarse. Fribourg (17xx) and Biel/Bienne (25xx)
// are genuinely bilingual and a handful of Valais communes sit on the wrong
// side of 3900; a florist there may get the less-likely of their two
// languages. That is a far smaller error than the status quo, where all 1,061
// get English, and any shop can still be corrected by setting
// `florists.locale` explicitly — the stored column always wins.
const SWISS_RANGES: { from: number; to: number; locale: Locale }[] = [
  { from: 1000, to: 2999, locale: "fr" }, // Geneva, Vaud, Neuchâtel, Jura
  { from: 6500, to: 6999, locale: "it" }, // Ticino, Italian Grisons
];

/** The language implied by a Swiss address's postcode, or null when the
 * address carries no 4-digit postcode we can read (e.g. "Zürich,
 * Switzerland", of which production has exactly one). */
export function swissLocaleFromPostcode(address: string | null | undefined): Locale | null {
  if (!address) return null;
  // Anchored on a word boundary so a house number or a "CH-" prefix cannot be
  // read as a postcode, and scanning ALL matches rather than the first, since
  // the street number comes earlier in the string than the postcode does.
  const candidates = address.match(/\b\d{4}\b/g);
  if (!candidates) return null;
  for (const raw of candidates) {
    const pc = Number(raw);
    if (pc < 1000) continue;
    const hit = SWISS_RANGES.find((r) => pc >= r.from && pc <= r.to);
    if (hit) return hit.locale;
    return "de"; // in range 3000-6499 or 7000-9999: German-speaking
  }
  return null;
}

/** The outbound locale implied by a shop's own address, or null when the
 * address cannot decide it (no country named, a country with no supported
 * catalog, or a Swiss address with no readable postcode).
 *
 * This is the REPLACEMENT for passing the city's country as
 * `resolveFloristLocale`'s fallbackRegion. It never overrides a stored
 * `florists.locale` — that remains the florist's own choice and wins outright;
 * this only supplies a better answer than the city did when the column is
 * empty. */
export function localeFromAddress(address: string | null | undefined): Locale | null {
  const country = countryFromAddress(address);
  if (!country) return null;
  // CH is the case the country code provably cannot answer — see the
  // deliberately-absent note in lib/i18n/locales.ts.
  if (country === "CH") return swissLocaleFromPostcode(address);
  return regionToLocale(country);
}
