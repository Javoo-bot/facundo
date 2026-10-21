// The one place a florist-facing send decides what language to write in.
//
// WHY THIS IS NOT IN lib/i18n: the obvious home for this is
// `resolveFloristLocale` itself, so every caller gets it for free. It cannot
// go there. `@/lib/i18n` is imported by client components, and
// lib/shopCountry.ts pulls in 24 country-name JSON catalogues to read
// addresses written in 24 languages — putting that behind the i18n barrel
// would ship all of it to the browser for the sake of a server-side send
// decision. So the address-aware step lives here, in a server-only module the
// send paths share, and lib/i18n stays the pure, client-safe core.
//
// Added 2026-09-16 — see
// docs/superpowers/specs/2026-09-16-florist-locale-and-reply-failures-design.md.
// Relative imports (with .ts extensions) rather than the usual `@/lib/...`
// alias: this file is imported relatively by floristLocale.test.mjs and run
// under plain `node --test`, which has no alias resolution — the same
// constraint lib/phone.ts, lib/shopCountry.ts and lib/replyToken.ts carry.
import { resolveFloristLocale, isLocale, type Locale } from "./i18n/index.ts";
import { localeFromAddress } from "./shopCountry.ts";

/** The columns a caller must have selected for this to do its job. Both are
 * optional so an existing projection can be passed as-is — omitting `address`
 * simply degrades to the old city-country behaviour rather than failing. */
export interface FloristLocaleFields {
  locale?: string | null;
  address?: string | null;
}

/** Resolve the outbound locale for one florist, best source first:
 *
 *   1. `florists.locale` — the florist's own choice, set at ingest or picked
 *      by them. Always wins, including an explicit "en".
 *   2. the shop's OWN address — knows it is in Cranves-Sales, France, rather
 *      than merely "somewhere within 20 km of Founex, CH".
 *   3. `fallbackRegion`, the country of the city it was ingested under — the
 *      pre-2026-09-16 behaviour, kept because ~5% of addresses name no
 *      country at all and something must still answer for them.
 *
 * (2) exists because city radii cross borders: 46 of Founex's 174 shops are
 * in France and Basel holds shops in three countries, so (3) was wrong for
 * whole populations at once. Never throws; worst case it returns EN, exactly
 * as before. */
export function resolveFloristSendLocale(
  florist: FloristLocaleFields | null | undefined,
  fallbackRegion?: string | null
): Locale {
  const f = florist ?? {};
  if (isLocale(f.locale)) return f.locale;
  return localeFromAddress(f.address ?? null) ?? resolveFloristLocale(f, fallbackRegion);
}
