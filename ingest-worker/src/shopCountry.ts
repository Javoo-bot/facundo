// The country a florist shop is ACTUALLY in, read from its own address.
//
// Worker twin of dashboard/lib/shopCountry.ts and ingest/shop_country.py —
// separate builds, no shared module; keep all three in step.
//
// WHY THIS EXISTS — and why the Worker copy is the one that matters most.
// workflow.ts resolves ONE phone region per city (`countryToRegion(p.country)`)
// and hands it to every row it builds. City radii are 20 km and cross borders,
// so a French shop inside a Swiss city's radius had its LOCAL phone number
// parsed as Swiss.
//
// That is exactly what happened to the florist on order #2000034. Enrichment
// correctly extracted "04 50 00 11 22" from the shop's own site. buildRow then
// ran normalizePhone("04 50 00 11 22", "CH") — and libphonenumber-js ACCEPTS
// that as a valid Swiss number, returning "+41 45 000 11 22". Telnyx rejected
// the offer SMS with "Invalid destination number".
//
// Note the Python ingest would NOT have produced this: python-phonenumbers
// rejects the same input under CH and normalize_phone keeps it verbatim. The
// two libraries disagree on this number, so a bug that the Python path is
// accidentally immune to lives on in the Worker. Both now take the shop's own
// address rather than relying on that accident.
//
// See docs/superpowers/specs/2026-09-16-florist-locale-and-reply-failures-design.md.

import * as countries from "i18n-iso-countries";
import en from "i18n-iso-countries/langs/en.json";
import de from "i18n-iso-countries/langs/de.json";
import fr from "i18n-iso-countries/langs/fr.json";
import es from "i18n-iso-countries/langs/es.json";
import it from "i18n-iso-countries/langs/it.json";
import pt from "i18n-iso-countries/langs/pt.json";
import nl from "i18n-iso-countries/langs/nl.json";
import ca from "i18n-iso-countries/langs/ca.json";
import da from "i18n-iso-countries/langs/da.json";
import sv from "i18n-iso-countries/langs/sv.json";
import nb from "i18n-iso-countries/langs/nb.json";
import fi from "i18n-iso-countries/langs/fi.json";
import et from "i18n-iso-countries/langs/et.json";
import pl from "i18n-iso-countries/langs/pl.json";
import cs from "i18n-iso-countries/langs/cs.json";
import sk from "i18n-iso-countries/langs/sk.json";
import hr from "i18n-iso-countries/langs/hr.json";
import sr from "i18n-iso-countries/langs/sr.json";
import ro from "i18n-iso-countries/langs/ro.json";
import bg from "i18n-iso-countries/langs/bg.json";
import el from "i18n-iso-countries/langs/el.json";
import tr from "i18n-iso-countries/langs/tr.json";
import he from "i18n-iso-countries/langs/he.json";
import ar from "i18n-iso-countries/langs/ar.json";

// Every language observed in the production `florists.address` column as of
// 2026-09-16, plus the obvious neighbours. Google returns the country name in
// the language of the scrape, so "Frankreich" and "France" both appear.
const NAME_LOCALES = [en, de, fr, es, it, pt, nl, ca, da, sv, nb, fi, et,
                      pl, cs, sk, hr, sr, ro, bg, el, tr, he, ar];
for (const l of NAME_LOCALES) countries.registerLocale(l as never);

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// normalized name (any registered language) -> alpha-2. A name claimed by two
// different countries across languages is dropped rather than arbitrated.
const NAME_TO_ALPHA2: Map<string, string> = (() => {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const l of NAME_LOCALES) {
    const locale = (l as { locale: string }).locale;
    const names = countries.getNames(locale) as Record<string, string | string[]>;
    for (const [alpha2, value] of Object.entries(names)) {
      for (const name of Array.isArray(value) ? value : [value]) {
        const key = name ? normalize(name) : "";
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

// Google sometimes puts the postcode after the country
// ("…, Zakarpattia Oblast, Ukrajina, 88000"), so scan three trailing segments.
const TAIL_SEGMENTS = 3;

/** The shop's alpha-2 country from the tail of its address, or null when the
 * address names none (~5% of production rows). Null is a first-class answer:
 * a guess is how a French shop ended up on a Swiss country code. */
export function countryFromAddress(address: string | null | undefined): string | null {
  if (!address || !address.trim()) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  for (const segment of parts.slice(-TAIL_SEGMENTS).reverse()) {
    const hit = NAME_TO_ALPHA2.get(normalize(segment));
    if (hit) return hit;
  }
  return null;
}

/** The region to parse this shop's LOCAL phone numbers against: the shop's
 * own address first, the city's region only when the address names no
 * country. Numbers that already carry "+<country code>" are unaffected either
 * way — the region is only ever a default for local-format numbers. */
export function phoneRegionFor(address: string | null | undefined, cityRegion: string | null): string | null {
  return countryFromAddress(address) ?? cityRegion;
}
