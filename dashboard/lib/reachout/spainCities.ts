// The Spanish cities the Reach Out campaign targets.
//
// Plain data, no I/O — paste-ready for the existing bulk-add box
// (components/BulkAddCityForm.tsx → lib/cityList.ts::parseCityList). There is
// deliberately NO new ingest path here: the control already exists and takes
// "Country, City" one per line, so this file only supplies the lines.
//
// ---- Why 50 and not 200
//
// Apify is on the STARTER plan with a HARD ceiling of $19/month — exceeded, it
// fails runs mid-flight with "Monthly usage hard limit exceeded" rather than
// throttling, which is exactly how three cities died on 2026-09-09. At the
// measured $4.00/1,000 places and a 25-place cap that is ~$0.10 a city, so 50
// cities is ~$5 and comfortably inside the ceiling. 200 cities uncapped would
// be ~$200 and 200 capped ~$20 — over it. The list can grow when the plan does.
//
// ---- Order
//
// Largest first, by municipality population. Recruiting value follows florist
// density, which follows population, so a truncated run still gets the cities
// that matter. It also means the expensive cities are the ones already done.
//
// ---- Radius, and why it is not just "10 for big, 30 for small"
//
// Two facts pull in opposite directions.
//
// TOO SMALL RETURNS NOTHING. Soria (40k) was scraped twice on 2026-09-10, same
// city, same limit, only the radius changed: at 10 km Apify returned **0**
// florists (`outOfLocation: 164` — every place Google found sat outside the
// circle) and at 30 km it returned **24**, for $0.147. A too-tight radius does
// not fail loudly; it books a green `succeeded` row with a zero count, which is
// the worst possible shape for a mistake.
//
// TOO LARGE SILENTLY DELETES SHOPS FROM THE CAMPAIGN. `florists` is unique on
// `(city_id, place_id)` — NOT on `place_id` — so one shop caught by two
// overlapping circles becomes two rows with one email. The shared-address sweep
// then sets `email_shared_count = 2` on both, and autoEnrol.ts blocks BOTH with
// reason "shared-address". The shop is not mailed twice; it is never mailed at
// all. This is measured, not theoretical: prod holds **215** Spanish shops
// filed under two cities, and the pairs are precisely the adjacent ones —
// Santa Cruz de Tenerife / La Laguna (8 km apart) accounts for 124 of them and
// Las Palmas / Telde (a 20 km radius over a 20 km gap) for another 77.
//
// So the rule is the requested two buckets, plus one geometric invariant that
// overrides them:
//
//   base:      population >= 200k -> 10 km, otherwise 30 km
//   invariant: for any two scrape targets A and B,
//              radiusKm(A) + radiusKm(B) <= distance(A, B)
//
// Where the invariant cannot be satisfied — the Madrid and Barcelona commuter
// belts are municipalities 3–8 km apart, which no positive radius survives —
// the smaller municipality stops being its own scrape target and is absorbed by
// its neighbour's widened circle (`coveredBy`). Nine of the fifty are absorbed
// that way, so 50 cities are COVERED by 41 scrape jobs. Every exception is
// annotated with the distance that forced it, and spainCities.test.mjs asserts
// both halves of the invariant against real coordinates.

/** One city, in the shape `parseCityList` expects on the left of the comma. */
export interface SpainCity {
  city: string;
  /** Municipality population, INE padrón, rounded to the nearest thousand. Only
   * job is to pick the base radius bucket, so the rounding is harmless. */
  population: number;
  lat: number;
  lng: number;
  /** Radius for this city's own scrape, km. Undefined iff `coveredBy` is set. */
  radiusKm?: number;
  /** Set when this municipality is inside another target's circle, so scraping
   * it separately would duplicate shops rather than find new ones. The value is
   * the covering city's name; the comment gives the centre-to-centre distance. */
  coveredBy?: string;
  /** Already in the database. Re-running is HARMLESS — ingest upserts on
   * (city_id, place_id), so nothing duplicates — but it is not free, so these
   * are excluded from the default paste. */
  scraped?: boolean;
}

/** Verified against STAGING on 2026-09-10, which holds 21 ES cities. Prod's
 * Spanish set is different and smaller (no Valencia, no Sevilla, and a Madrid
 * row with zero florists), so re-check before running this list against prod
 * rather than trusting the flag — it is a snapshot and the table moves. */
export const SPAIN_CITIES: readonly SpainCity[] = [
  // --- Madrid metro. Madrid is widened to 25 km, which swallows the five inner
  // satellites below (all 11–20 km out). At the requested 10 km it would reach
  // none of them, and giving each its own circle is impossible: Leganés and
  // Getafe are 3.4 km apart, so any radius above 1.7 km overlaps.
  { city: "Madrid", population: 3_423_000, lat: 40.4168, lng: -3.7038, radiusKm: 25, scraped: true },
  // 14 km, not 15: Sabadell is 18.4 km out and needs 4 of its own. Still
  // absorbs Hospitalet (6 km), Santa Coloma (6 km) and Badalona (9 km).
  { city: "Barcelona", population: 1_660_000, lat: 41.3874, lng: 2.1686, radiusKm: 14, scraped: true },
  { city: "Valencia", population: 807_000, lat: 39.4699, lng: -0.3763, radiusKm: 10, scraped: true },
  { city: "Zaragoza", population: 687_000, lat: 41.6488, lng: -0.8891, radiusKm: 10 },
  // Widened to 15 km to absorb Dos Hermanas (12 km); at 10 km neither reaches it.
  { city: "Sevilla", population: 681_000, lat: 37.3891, lng: -5.9845, radiusKm: 15, scraped: true },
  { city: "Málaga", population: 592_000, lat: 36.7213, lng: -4.4213, radiusKm: 10 },
  { city: "Murcia", population: 468_000, lat: 37.9922, lng: -1.1307, radiusKm: 10 },
  { city: "Palma", population: 424_000, lat: 39.5696, lng: 2.6502, radiusKm: 10, scraped: true },
  { city: "Las Palmas de Gran Canaria", population: 381_000, lat: 28.1235, lng: -15.4363, radiusKm: 10, scraped: true },
  { city: "Bilbao", population: 348_000, lat: 43.2630, lng: -2.9350, radiusKm: 10 },
  { city: "Alicante", population: 338_000, lat: 38.3452, lng: -0.4810, radiusKm: 10 },
  { city: "Córdoba", population: 319_000, lat: 37.8882, lng: -4.7794, radiusKm: 10 },
  { city: "Valladolid", population: 299_000, lat: 41.6523, lng: -4.7245, radiusKm: 10 },
  { city: "Vigo", population: 296_000, lat: 42.2406, lng: -8.7207, radiusKm: 10 },
  { city: "Hospitalet de Llobregat", population: 277_000, lat: 41.3596, lng: 2.0999, coveredBy: "Barcelona" }, // 6 km
  { city: "Gijón", population: 270_000, lat: 43.5322, lng: -5.6611, radiusKm: 10 },
  { city: "Vitoria-Gasteiz", population: 257_000, lat: 42.8467, lng: -2.6716, radiusKm: 10 },
  { city: "A Coruña", population: 249_000, lat: 43.3623, lng: -8.4115, radiusKm: 10 },
  { city: "Elche", population: 240_000, lat: 38.2699, lng: -0.7126, radiusKm: 10 },
  { city: "Granada", population: 232_000, lat: 37.1773, lng: -3.5986, radiusKm: 10 },
  // Terrassa/Sabadell are 8 km apart and 20–28 km from Barcelona's 15 km circle,
  // so they stay targets but at 4 km — the largest pair of equal radii that fits.
  { city: "Terrassa", population: 231_000, lat: 41.5610, lng: 2.0089, radiusKm: 4 },
  { city: "Badalona", population: 226_000, lat: 41.4500, lng: 2.2474, coveredBy: "Barcelona" }, // 9 km
  { city: "Cartagena", population: 219_000, lat: 37.6257, lng: -0.9966, radiusKm: 10 },
  { city: "Sabadell", population: 218_000, lat: 41.5463, lng: 2.1086, radiusKm: 4, scraped: true },
  { city: "Oviedo", population: 218_000, lat: 43.3619, lng: -5.8494, radiusKm: 10 },
  { city: "Jerez de la Frontera", population: 213_000, lat: 36.6850, lng: -6.1261, radiusKm: 10 },
  { city: "Móstoles", population: 211_000, lat: 40.3223, lng: -3.8649, coveredBy: "Madrid" }, // 18 km
  { city: "Pamplona", population: 206_000, lat: 42.8125, lng: -1.6458, radiusKm: 10 },
  { city: "Almería", population: 202_000, lat: 36.8340, lng: -2.4637, radiusKm: 10 },
  // Below 200k, so the base bucket is 30 km. Alcalá is 31 km from Madrid, whose
  // circle is 25 km, leaving 6 km — set to 5.
  { city: "Alcalá de Henares", population: 197_000, lat: 40.4820, lng: -3.3635, radiusKm: 5 },
  { city: "Fuenlabrada", population: 193_000, lat: 40.2842, lng: -3.7942, coveredBy: "Madrid" }, // 20 km
  { city: "Leganés", population: 191_000, lat: 40.3272, lng: -3.7635, coveredBy: "Madrid" }, // 11 km
  { city: "San Sebastián", population: 189_000, lat: 43.3183, lng: -1.9812, radiusKm: 30 },
  { city: "Getafe", population: 187_000, lat: 40.3057, lng: -3.7329, coveredBy: "Madrid" }, // 13 km
  { city: "Burgos", population: 176_000, lat: 42.3439, lng: -3.6969, radiusKm: 30 },
  { city: "Castellón de la Plana", population: 176_000, lat: 39.9864, lng: -0.0513, radiusKm: 30 },
  { city: "Albacete", population: 175_000, lat: 38.9943, lng: -1.8585, radiusKm: 30 },
  { city: "Santander", population: 172_000, lat: 43.4623, lng: -3.8100, radiusKm: 30 },
  { city: "Alcorcón", population: 171_000, lat: 40.3459, lng: -3.8249, coveredBy: "Madrid" }, // 14 km
  { city: "Marbella", population: 160_000, lat: 36.5101, lng: -4.8825, radiusKm: 30 },
  { city: "Logroño", population: 153_000, lat: 42.4627, lng: -2.4450, radiusKm: 30 },
  { city: "Badajoz", population: 149_000, lat: 38.8794, lng: -6.9707, radiusKm: 30 },
  { city: "Salamanca", population: 144_000, lat: 40.9701, lng: -5.6635, radiusKm: 30 },
  { city: "Huelva", population: 143_000, lat: 37.2614, lng: -6.9447, radiusKm: 30 },
  { city: "Lleida", population: 142_000, lat: 41.6176, lng: 0.6200, radiusKm: 30 },
  { city: "Tarragona", population: 138_000, lat: 41.1189, lng: 1.2445, radiusKm: 30 },
  { city: "Dos Hermanas", population: 137_000, lat: 37.2836, lng: -5.9223, coveredBy: "Sevilla" }, // 12 km
  { city: "León", population: 122_000, lat: 42.5987, lng: -5.5671, radiusKm: 30 },
  { city: "Santa Coloma de Gramenet", population: 119_000, lat: 41.4515, lng: 2.2081, coveredBy: "Barcelona" }, // 6 km
  // 30 km would reach well into Jerez's circle, only 22.8 km away; 12 km is the
  // largest that clears it. Cádiz sits on a peninsula, so 12 km still takes in
  // San Fernando, Puerto Real and El Puerto de Santa María — the dense half of
  // the bay. The gap between the two circles is Chiclana, which neither reaches.
  { city: "Cádiz", population: 110_000, lat: 36.5271, lng: -6.2886, radiusKm: 12 },
];

/** The population at or above which a city gets the tight 10 km circle. Below
 * it the town is sparse enough that 10 km returns nothing — see the Soria
 * 0-vs-24 result in the header. */
export const BIG_CITY_POPULATION = 200_000;

/** The two requested buckets. `baseRadiusKm` is what the rule alone would give;
 * the actual `radiusKm` on a city may be smaller where the non-overlap
 * invariant forced it down, or larger where a city absorbs its satellites. */
export function baseRadiusKm(population: number): 10 | 30 {
  return population >= BIG_CITY_POPULATION ? 10 : 30;
}

/** The country code `cities.country` stores and `parseCityList` passes through
 * verbatim. ISO-2 on live data; the pipeline's `normalize_country` accepts
 * either this or the full name. */
export const SPAIN_COUNTRY = "ES";

/** Cities that get their own Apify run — i.e. everything not absorbed into a
 * neighbour's circle. */
export function scrapeTargets(): SpainCity[] {
  return SPAIN_CITIES.filter((c) => c.coveredBy === undefined);
}

/** The cities a run would actually scrape, largest first.
 *
 * `max` truncates the run, and truncating in POPULATION order is the point:
 * the one-city staging rehearsal should exercise a real market, not whichever
 * city happens to sort first by some unrelated key.
 *
 * Defaults to cities NOT yet scraped — re-running a scraped city adds nothing
 * and still costs money. Pass `{ includeScraped: true }` to rebuild the whole
 * market deliberately. */
export function citiesToScrape(opts: { includeScraped?: boolean; max?: number } = {}): SpainCity[] {
  const targets = scrapeTargets().filter((c) => opts.includeScraped || !c.scraped);
  return opts.max === undefined ? targets : targets.slice(0, Math.max(0, opts.max));
}

/** One batch per distinct radius, because `POST /api/ingest` takes a single
 * `radius` for a whole batch (lib/ingestBatch.ts) — a mixed-radius run is
 * several requests, not one.
 *
 * Batches are ordered by their LARGEST city, so a run that is stopped early has
 * still covered the markets that matter. An earlier version sorted widest-radius
 * first on the theory that the widest circles were the biggest markets; that is
 * exactly backwards — the 30 km circles are the SMALLEST towns (a wide circle is
 * what a sparse province needs), so it put the least valuable cities first. */
export function spainCityBatches(
  opts: { includeScraped?: boolean; max?: number } = {}
): { radiusKm: number; lines: string[]; cities: SpainCity[] }[] {
  const byRadius = new Map<number, SpainCity[]>();
  for (const c of citiesToScrape(opts)) {
    const r = c.radiusKm as number;
    if (!byRadius.has(r)) byRadius.set(r, []);
    byRadius.get(r)!.push(c);
  }
  return [...byRadius.entries()]
    .map(([radiusKm, cities]) => ({
      radiusKm,
      cities,
      lines: cities.map((c) => `${SPAIN_COUNTRY}, ${c.city}`),
    }))
    .sort((a, b) => b.cities[0].population - a.cities[0].population);
}

/** The exact request bodies the Reach Out button POSTs to `/api/ingest`.
 *
 * Separated from the component and kept pure so the thing that spends money is
 * unit-testable: the button itself only loops over what this returns. */
export interface IngestBatchBody {
  cities: { country: string; city: string }[];
  radius: number;
  limit: number;
}
export function planIngestRequests(
  opts: { includeScraped?: boolean; max?: number; limit?: number } = {}
): IngestBatchBody[] {
  const limit = opts.limit ?? PLACES_PER_CITY;
  return spainCityBatches(opts).map((b) => ({
    cities: b.cities.map((c) => ({ country: SPAIN_COUNTRY, city: c.city })),
    radius: b.radiusKm,
    limit,
  }));
}

/** Every paste line, flattened — for the count and the cost estimate. The
 * radius is lost here, so use `spainCityBatches` to actually run them. */
export function spainCityLines(opts: { includeScraped?: boolean; max?: number } = {}): string[] {
  return spainCityBatches(opts).flatMap((b) => b.lines);
}

/** What a run of `lines` is expected to cost on Apify, in USD.
 *
 * `$4.00 per 1,000 places` is measured, not quoted: three runs on 2026-09-09
 * returned 279 → $1.12 and 285 → $1.14 twice. `placesPerCity` is the per-city
 * cap the operator will submit, which since 2026-09-09 is a TOTAL and not a
 * per-keyword number. Exists so a 50-city run can be checked against the $19
 * ceiling before it is started rather than after it fails.
 *
 * Note that the radius does NOT enter this: Apify charges per place returned
 * and the cap bounds that, so a 30 km circle costs the same as a 10 km one —
 * it just finds shops the tighter circle missed. Soria at 30 km cost $0.147. */
/** Places scraped per city, across all keywords — the `limit` the button
 * submits and the number every cost estimate here is based on. ~58% survive
 * the relevance filter, so 25 costs ~$0.10 and yields ~15 shops. */
export const PLACES_PER_CITY = 25;

export const USD_PER_PLACE = 0.004;
export function estimateSpendUsd(cityCount: number, placesPerCity: number): number {
  const raw = Math.max(0, cityCount) * Math.max(0, placesPerCity) * USD_PER_PLACE;
  // Rounded to cents: 285 * 0.004 is 1.1400000000000001 in binary floating
  // point, and an estimate rendered as "$1.1400000000000001" reads as a bug in
  // the arithmetic rather than a fact about doubles. Same reason lib/cost.ts
  // rounds its totals.
  return Math.round(raw * 100) / 100;
}
