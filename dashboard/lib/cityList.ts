export interface ParsedCity {
  country: string;
  city: string;
}

export interface CityListResult {
  cities: ParsedCity[];
  errors: { line: string; reason: string }[];
}

/** Parse a "Country, City" (one per line) paste into validated pairs.
 * Splits on the FIRST comma so a city containing commas survives. Blank
 * lines are skipped; lines without a comma or missing a part are reported
 * (never silently dropped). Dedups case-insensitively, keeping the first. */
export function parseCityList(raw: string): CityListResult {
  const cities: ParsedCity[] = [];
  const errors: { line: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const comma = line.indexOf(",");
    if (comma === -1) {
      errors.push({ line, reason: 'Expected "Country, City" — no comma found.' });
      continue;
    }
    const country = line.slice(0, comma).trim();
    const city = line.slice(comma + 1).trim();
    if (!country || !city) {
      errors.push({ line, reason: "Both country and city are required." });
      continue;
    }
    const key = `${country.toLowerCase()}|${city.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cities.push({ country, city });
  }

  return { cities, errors };
}
