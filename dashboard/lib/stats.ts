import type { City, Florist } from "./types";

/** The florist columns the per-city stats actually read. Declared as a Pick so
 * callers that hold a NARROWED row (e.g. /discovery, which no longer selects
 * `*` — see lib/types.ts::PipelineFlorist) still typecheck, and so dropping a
 * column from that select breaks the build instead of silently zeroing a stat.
 * `review_count` is in here for exactly that reason. */
export type CityStatsFlorist = Pick<
  Florist,
  "rating" | "review_count" | "is_ecommerce" | "email" | "phone_maps" | "phone_web" | "drafted_email"
>;

// Pure, side-effect-free aggregation helpers for the Overview + Hub page
// (docs/superpowers/specs/2026-07-02-overview-hub-design.md). Mirrors
// lib/scoring.ts's style: careful null guards so a city/florist with missing
// data never produces NaN or throws — an empty group (zero florists) must
// resolve to null/0, never divide-by-zero.

export interface CityStats {
  floristCount: number;
  // Average of non-null `rating` values. `null` (not 0) when no florist in
  // the group has a rating — defaulting a missing rating to 0 would skew the
  // average down, which is worse than just saying "no data yet".
  avgRating: number | null;
  // Sum of non-null `review_count`, treating null as 0 for the sum (a demand
  // proxy — total volume, not an average).
  totalReviews: number;
  // Count of florists rated >= 4.5 (a florist with a null rating never
  // qualifies).
  topTargets: number;
  // % of florists where is_ecommerce === true, out of floristCount. `null`
  // when floristCount is 0 (nothing to take a percentage of).
  pctEcommerce: number | null;
  // % of florists reachable via email OR either phone field, out of
  // floristCount. `null` when floristCount is 0.
  pctReachable: number | null;
  emailsFound: number;
  draftsReady: number;
  // Outreach-performance placeholders — no CRM (#3) yet, always null so the
  // UI renders "—" instead of a fabricated 0.
  emailsSent: null;
  replies: null;
  replyRate: null;
}

function emptyCityStats(): CityStats {
  return {
    floristCount: 0,
    avgRating: null,
    totalReviews: 0,
    topTargets: 0,
    pctEcommerce: null,
    pctReachable: null,
    emailsFound: 0,
    draftsReady: 0,
    emailsSent: null,
    replies: null,
    replyRate: null,
  };
}

/** Per-city stats for a single city's florists. */
export function computeCityStats(florists: CityStatsFlorist[]): CityStats {
  const floristCount = florists.length;
  if (floristCount === 0) return emptyCityStats();

  const rated = florists.filter((f) => f.rating != null);
  const avgRating =
    rated.length > 0
      ? rated.reduce((sum, f) => sum + (f.rating as number), 0) / rated.length
      : null;

  const totalReviews = florists.reduce((sum, f) => sum + (f.review_count ?? 0), 0);
  const topTargets = florists.filter((f) => f.rating != null && f.rating >= 4.5).length;
  const ecommerceCount = florists.filter((f) => f.is_ecommerce === true).length;
  const reachableCount = florists.filter((f) => f.email || f.phone_maps || f.phone_web).length;
  const emailsFound = florists.filter((f) => f.email != null).length;
  const draftsReady = florists.filter((f) => f.drafted_email != null).length;

  return {
    floristCount,
    avgRating,
    totalReviews,
    topTargets,
    pctEcommerce: (ecommerceCount / floristCount) * 100,
    pctReachable: (reachableCount / floristCount) * 100,
    emailsFound,
    draftsReady,
    emailsSent: null,
    replies: null,
    replyRate: null,
  };
}

/**
 * Rolls up the same CityStats shape over a group of already-computed
 * per-city stats. Sums counts; weighted-averages rating/percentages by each
 * city's floristCount (never average-of-averages — a 1-florist city and a
 * 100-florist city shouldn't count equally). Guards an empty group (or a
 * group whose cities all have zero florists) to the same null/0 shape as
 * computeCityStats([]).
 */
export function rollupCityStats(perCity: CityStats[]): CityStats {
  const floristCount = perCity.reduce((sum, s) => sum + s.floristCount, 0);
  if (floristCount === 0) return emptyCityStats();

  const totalReviews = perCity.reduce((sum, s) => sum + s.totalReviews, 0);
  const topTargets = perCity.reduce((sum, s) => sum + s.topTargets, 0);
  const emailsFound = perCity.reduce((sum, s) => sum + s.emailsFound, 0);
  const draftsReady = perCity.reduce((sum, s) => sum + s.draftsReady, 0);

  // Weighted average rating: reconstruct each city's rating-sum from
  // avgRating * (number of rated florists) isn't recoverable from CityStats
  // alone (we don't retain the rated count), so weight by floristCount as a
  // reasonable proxy at POC scale — cities with no ratings contribute 0
  // weight via the null check.
  const ratedCities = perCity.filter((s) => s.avgRating != null);
  const ratedWeight = ratedCities.reduce((sum, s) => sum + s.floristCount, 0);
  const avgRating =
    ratedWeight > 0
      ? ratedCities.reduce((sum, s) => sum + (s.avgRating as number) * s.floristCount, 0) /
        ratedWeight
      : null;

  const ecommerceCount = perCity.reduce(
    (sum, s) => sum + ((s.pctEcommerce ?? 0) / 100) * s.floristCount,
    0
  );
  const reachableCount = perCity.reduce(
    (sum, s) => sum + ((s.pctReachable ?? 0) / 100) * s.floristCount,
    0
  );

  return {
    floristCount,
    avgRating,
    totalReviews,
    topTargets,
    pctEcommerce: (ecommerceCount / floristCount) * 100,
    pctReachable: (reachableCount / floristCount) * 100,
    emailsFound,
    draftsReady,
    emailsSent: null,
    replies: null,
    replyRate: null,
  };
}

// Region group key used when a city's `region` is null or empty — the UI
// labels this "Other".
export const OTHER_REGION = "Other";

export interface RegionGroup {
  region: string; // OTHER_REGION for null/empty regions
  cities: (City & { stats: CityStats })[];
  stats: CityStats;
}

export interface CountryGroup {
  country: string;
  regions: RegionGroup[];
  stats: CityStats;
}

/**
 * Groups cities by country, then by region (null/empty region -> "Other"),
 * computing per-city stats plus region- and country-level rollups. Cities
 * and regions within a country are sorted alphabetically ("Other" sorts
 * wherever "O" falls, which is fine for a POC-scale list).
 */
export function groupCitiesByCountryAndRegion<F extends CityStatsFlorist & { city_id: string }>(
  cities: City[],
  florists: F[]
): CountryGroup[] {
  const floristsByCity = new Map<string, F[]>();
  for (const f of florists) {
    const list = floristsByCity.get(f.city_id);
    if (list) list.push(f);
    else floristsByCity.set(f.city_id, [f]);
  }

  const byCountry = new Map<string, Map<string, City[]>>();
  for (const city of cities) {
    const regionKey = city.region && city.region.trim() !== "" ? city.region : OTHER_REGION;
    let regions = byCountry.get(city.country);
    if (!regions) {
      regions = new Map();
      byCountry.set(city.country, regions);
    }
    const list = regions.get(regionKey);
    if (list) list.push(city);
    else regions.set(regionKey, [city]);
  }

  const countryGroups: CountryGroup[] = [];
  for (const [country, regions] of byCountry) {
    const regionGroups: RegionGroup[] = [];
    for (const [region, regionCities] of regions) {
      const citiesWithStats = regionCities
        .map((city) => ({ ...city, stats: computeCityStats(floristsByCity.get(city.id) ?? []) }))
        .sort((a, b) => a.city.localeCompare(b.city));
      regionGroups.push({
        region,
        cities: citiesWithStats,
        stats: rollupCityStats(citiesWithStats.map((c) => c.stats)),
      });
    }
    regionGroups.sort((a, b) => a.region.localeCompare(b.region));

    countryGroups.push({
      country,
      regions: regionGroups,
      stats: rollupCityStats(regionGroups.map((r) => r.stats)),
    });
  }
  countryGroups.sort((a, b) => a.country.localeCompare(b.country));

  return countryGroups;
}

export interface GlobalSummary {
  countries: number;
  // Distinct non-"Other" regions across all cities. "Other" (null/empty
  // region) is deliberately excluded from the count — it's a catch-all
  // bucket, not a real administrative region, so counting it would overstate
  // geographic coverage. hasOtherRegion tells the UI whether to render an
  // "(+ Other)" footnote if it wants one.
  regions: number;
  hasOtherRegion: boolean;
  cities: number;
  totalFlorists: number;
  totalReachable: number;
  totalEcommerce: number;
  draftsReady: number;
  // Weighted across all florists with a non-null rating (not
  // average-of-averages across cities) — a fair overall figure regardless of
  // how florists are distributed across cities.
  overallAvgRating: number | null;
}

/** The roster-wide florist numbers in a GlobalSummary, decoupled from the
 * roster itself.
 *
 * The home page reads these straight out of the `florist_summary` view (one
 * row) instead of pulling all 6,264 florists into the browser to count them —
 * that was ~11.4 MB a render for five numbers. Callers that already hold the
 * rows for other reasons (e.g. /discovery, which groups them per city) can
 * derive the same shape with `aggregateFlorists` below. */
export interface FloristAggregates {
  totalFlorists: number;
  totalReachable: number;
  totalEcommerce: number;
  draftsReady: number;
  overallAvgRating: number | null;
}

/** The JS equivalent of the `florist_summary` view — for callers that already
 * have the rows in hand. The two definitions must agree; the view's comment
 * points back here. */
export function aggregateFlorists(
  florists: Pick<Florist, "email" | "phone_maps" | "phone_web" | "is_ecommerce" | "drafted_email" | "rating">[]
): FloristAggregates {
  const rated = florists.filter((f) => f.rating != null);
  return {
    totalFlorists: florists.length,
    totalReachable: florists.filter((f) => f.email || f.phone_maps || f.phone_web).length,
    totalEcommerce: florists.filter((f) => f.is_ecommerce === true).length,
    draftsReady: florists.filter((f) => f.drafted_email != null).length,
    overallAvgRating:
      rated.length > 0 ? rated.reduce((sum, f) => sum + (f.rating as number), 0) / rated.length : null,
  };
}

export function computeGlobalSummary(cities: City[], florists: FloristAggregates): GlobalSummary {
  const countries = new Set(cities.map((c) => c.country)).size;
  const regionSet = new Set(
    cities
      .map((c) => (c.region && c.region.trim() !== "" ? c.region : null))
      .filter((r): r is string => r != null)
  );
  const hasOtherRegion = cities.some((c) => !c.region || c.region.trim() === "");

  return {
    countries,
    regions: regionSet.size,
    hasOtherRegion,
    cities: cities.length,
    ...florists,
  };
}
