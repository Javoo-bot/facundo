// Tiny geo helper. Pure, null-guarded — a missing coordinate yields null, never
// NaN (per the repo's null-guard convention for lat/lng math).

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km between two lat/lng points, rounded to one
 *  decimal. Returns null if any coordinate is null/undefined/non-finite — so
 *  callers can render "—" rather than a bogus number. */
export function haversineKm(
  aLat: number | null | undefined,
  aLng: number | null | undefined,
  bLat: number | null | undefined,
  bLng: number | null | undefined,
): number | null {
  for (const v of [aLat, aLng, bLat, bLng]) {
    if (v == null || !Number.isFinite(v)) return null;
  }
  const dLat = rad((bLat as number) - (aLat as number));
  const dLng = rad((bLng as number) - (aLng as number));
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat as number)) * Math.cos(rad(bLat as number)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
  return Math.round(km * 10) / 10;
}

/** Render a distance the way every surface in the app shows one: one decimal
 *  under 10 km (where the difference is worth reading), whole km above. Null in,
 *  null out — the caller decides whether that's "—" or a hidden field. */
export function formatKm(km: number | null | undefined): string | null {
  if (km == null || !Number.isFinite(km)) return null;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}
