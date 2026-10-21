import type { Florist } from "./types";

/**
 * Great-circle distance in meters. Null-guard correction: `lat`/`lng` are
 * nullable columns. Callers must not pass florists with a null lat/lng — this
 * function returns Infinity in that case (never NaN) as a defensive fallback so
 * a bad call can't silently corrupt the greedy selection below.
 */
export function haversineMeters(a: Florist, b: Florist): number {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) {
    return Infinity;
  }
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Greedy diversity selection — take the highest-scoring florist that isn't too
 * close to any already-selected florist. `ranked` must already be sorted by
 * score, descending.
 *
 * Null-guard correction: florists with no lat/lng can't be plotted or measured
 * for separation, so they are skipped entirely rather than allowed to corrupt
 * the selection (they'd otherwise always pass the "not too close" check against
 * an Infinity distance).
 */
export function selectSpread(
  ranked: Florist[],
  k: number,
  minSeparationMeters: number
): Florist[] {
  const locatable = ranked.filter((f) => f.lat != null && f.lng != null);
  const selected: Florist[] = [];
  for (const f of locatable) {
    if (selected.length >= k) break;
    const tooClose = selected.some((s) => haversineMeters(f, s) < minSeparationMeters);
    if (!tooClose) selected.push(f);
  }
  return selected;
}
