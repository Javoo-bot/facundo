// City-center geocoding via Nominatim (OpenStreetMap).
//
// Ported from ingest/geocode.py. Nominatim's usage policy requires a
// descriptive custom User-Agent and caps requests at 1/sec. Since `cities`
// acts as a cache (unique on country+city), callers should skip geocoding
// entirely when the row already exists — this module only performs the
// actual lookup.

import { USER_AGENT, NOMINATIM_MIN_REQUEST_INTERVAL_MS } from "./config";

let lastRequestAt = 0;

/** Enforce Nominatim's <=1 request/sec usage policy. */
async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < NOMINATIM_MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, NOMINATIM_MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

// Matches ingest/geocode.py::_REGION_ADDRESS_KEYS order.
const REGION_ADDRESS_KEYS = ["state", "province", "region", "state_district"] as const;

interface NominatimAddress {
  state?: string;
  province?: string;
  region?: string;
  state_district?: string;
  [key: string]: unknown;
}

interface NominatimResult {
  lat: string;
  lon: string;
  address?: NominatimAddress;
  [key: string]: unknown;
}

/** Extract the administrative region from a Nominatim address block,
 * preferring (in order) state, province, region, then state_district. */
function extractRegion(address: NominatimAddress | undefined): string | null {
  if (!address) return null;
  for (const key of REGION_ADDRESS_KEYS) {
    const value = address[key];
    if (value) return value;
  }
  return null;
}

/** Reverse-geocode `near` — a village/suburb-level lookup (zoom=14) around a
 * point Nominatim's free-text search couldn't resolve at all. Exists for
 * exactly the 2026-09-04 "SAINT BARTHOLOMY, CH" case: a real order's
 * delivery address geocoded to a real point (near Saint-Barthélemy, Vaud),
 * but the order's own `city` string reached us mangled (missing the accent
 * AND misspelled — "Bartholomy" vs "Barthélemy"), so the forward query
 * matched nothing even though we're already standing right next to the real
 * place. Returns null (never throws) on any failure — the caller's existing
 * "could not geocode" error is a perfectly good fallback of the fallback. */
async function reverseGeocode(near: { lat: number; lng: number }): Promise<NominatimResult | null> {
  await throttle();
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=14&lat=${near.lat}&lon=${near.lng}`;
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) return null;
    const result = (await response.json()) as NominatimResult & { error?: string };
    if (!result || result.error || !result.lat || !result.lon) return null;
    return result;
  } catch {
    return null;
  }
}

// Generous on purpose — only meant to catch "wrong city entirely" mistakes
// like the ~900km San Carlos (Balears vs Castilla y León) mismatch that
// motivated this whole disambiguation path, not to enforce a tight radius.
export const MAX_GEOCODE_DRIFT_KM = 150;

/** Thrown when `near` is given and even the closest of Nominatim's candidates
 * lands further than MAX_GEOCODE_DRIFT_KM away — i.e. the region hint wasn't
 * enough to find a plausible match, and blindly trusting the top result would
 * risk repeating the San Carlos mismatch. */
export class GeocodeMismatchError extends Error {
  constructor(opts: {
    query: string;
    lat: number;
    lng: number;
    region: string | null;
    near: { lat: number; lng: number };
    driftKm: number;
  }) {
    super(
      `Nominatim query '${opts.query}' resolved to (${opts.lat}, ${opts.lng})` +
        ` region=${JSON.stringify(opts.region)}, which is ${opts.driftKm.toFixed(1)}km from the` +
        ` expected point (${opts.near.lat}, ${opts.near.lng}) — exceeds MAX_GEOCODE_DRIFT_KM=${MAX_GEOCODE_DRIFT_KM}km.`
    );
    this.name = "GeocodeMismatchError";
  }
}

/** Look up the (lat, lng) center of a city, plus its administrative region.
 *
 * `regionHint` (e.g. "Balears") is appended to the Nominatim query to
 * disambiguate same-named cities; omitted/blank falls back to today's
 * unhinted query exactly.
 *
 * `near` (a reference point, typically the order's own delivery_lat/lng) — when
 * given, requests several candidates instead of one and picks whichever is
 * closest to `near`, throwing GeocodeMismatchError if even the closest is
 * implausibly far. When omitted, behavior is unchanged from before this
 * parameter existed: single top-ranked result, no drift check.
 *
 * Throws if Nominatim has no result for the query at all. */
export async function geocodeCityCenter(
  country: string,
  city: string,
  regionHint?: string | null,
  near?: { lat: number; lng: number } | null
): Promise<{ lat: number; lng: number; region: string | null }> {
  const hint = regionHint?.trim();
  const query = hint ? `${city}, ${hint}, ${country}` : `${city}, ${country}`;
  await throttle();

  const limit = near ? 8 : 1;
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=${limit}&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Nominatim request failed with status ${response.status} for '${query}'`);
  }

  const results = (await response.json()) as NominatimResult[];
  if (!results || results.length === 0) {
    if (near) {
      const reversed = await reverseGeocode(near);
      if (reversed) {
        return {
          lat: parseFloat(reversed.lat),
          lng: parseFloat(reversed.lon),
          region: extractRegion(reversed.address),
        };
      }
    }
    throw new Error(`Nominatim could not geocode '${query}'`);
  }

  if (!near) {
    const result = results[0];
    return {
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
      region: extractRegion(result.address),
    };
  }

  let best: { result: NominatimResult; lat: number; lng: number; distanceKm: number } | null = null;
  for (const result of results) {
    const lat = parseFloat(result.lat);
    const lng = parseFloat(result.lon);
    const distanceKm = haversineKm(near, { lat, lng });
    if (!best || distanceKm < best.distanceKm) best = { result, lat, lng, distanceKm };
  }
  // results.length > 0 guarantees best is set.
  const chosen = best!;
  if (chosen.distanceKm > MAX_GEOCODE_DRIFT_KM) {
    // A forward query can return a *wrong* same-named place instead of no rows
    // at all (real case: Shopify sent "Trèves, FR" while the delivery point was
    // Trier, Germany). In that case the near point is still the trustworthy
    // reference, so use the same reverse-geocode fallback as the zero-results
    // path before failing closed.
    const reversed = await reverseGeocode(near);
    if (reversed) {
      return {
        lat: parseFloat(reversed.lat),
        lng: parseFloat(reversed.lon),
        region: extractRegion(reversed.address),
      };
    }
    throw new GeocodeMismatchError({
      query,
      lat: chosen.lat,
      lng: chosen.lng,
      region: extractRegion(chosen.result.address),
      near,
      driftKm: chosen.distanceKm,
    });
  }

  return {
    lat: chosen.lat,
    lng: chosen.lng,
    region: extractRegion(chosen.result.address),
  };
}

/** Great-circle distance between two points in km (haversine, R=6371).
 * Replaces geopy's geodesic distance for the pipeline's distance-from-center
 * calculation. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return R * c;
}
