// Mirrors the bounds in app/api/ingest/route.ts. Kept here so the batch
// validator is pure + unit-testable.
const MAX_STRING_LEN = 100;
const MIN_RADIUS_KM = 0.5;
const MAX_RADIUS_KM = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const MAX_CITIES = 50;

export interface BatchCity {
  country: string;
  city: string;
}
export interface BatchValue {
  cities: BatchCity[];
  radius: number;
  limit: number;
  resetExisting: boolean;
}

/** Validate + normalize a `{ cities: [...], radius, limit, resetExisting }`
 * batch-ingest body. Dedups cities case-insensitively. Pure; no I/O. */
export function parseBatchCities(
  body: unknown
): { ok: true; value: BatchValue } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const { cities, radius, limit, resetExisting } = body as Record<string, unknown>;
  if (!Array.isArray(cities) || cities.length === 0) {
    return { ok: false, message: "cities must be a non-empty array." };
  }
  if (cities.length > MAX_CITIES) {
    return { ok: false, message: `cities must contain at most ${MAX_CITIES} entries.` };
  }

  const seen = new Set<string>();
  const parsed: BatchCity[] = [];
  for (const entry of cities) {
    const { country, city } = (entry ?? {}) as Record<string, unknown>;
    if (typeof country !== "string" || typeof city !== "string") {
      return { ok: false, message: "each city needs string country and city." };
    }
    const c = country.trim();
    const t = city.trim();
    if (!c || !t) return { ok: false, message: "country and city must not be empty." };
    if (c.length > MAX_STRING_LEN || t.length > MAX_STRING_LEN) {
      return { ok: false, message: `country and city must be at most ${MAX_STRING_LEN} characters.` };
    }
    const key = `${c.toLowerCase()}|${t.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ country: c, city: t });
  }

  const radiusNum = typeof radius === "number" ? radius : Number(radius);
  if (!Number.isFinite(radiusNum) || radiusNum < MIN_RADIUS_KM || radiusNum > MAX_RADIUS_KM) {
    return { ok: false, message: `radius must be between ${MIN_RADIUS_KM} and ${MAX_RADIUS_KM} km.` };
  }
  const limitNum = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isInteger(limitNum) || limitNum < MIN_LIMIT || limitNum > MAX_LIMIT) {
    return { ok: false, message: `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}.` };
  }
  if (resetExisting !== undefined && typeof resetExisting !== "boolean") {
    return { ok: false, message: "resetExisting must be a boolean." };
  }

  return {
    ok: true,
    value: { cities: parsed, radius: radiusNum, limit: limitNum, resetExisting: resetExisting === true },
  };
}
