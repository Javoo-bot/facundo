// The pure half of ingest-on-empty: naming an area, and validating a request to
// scrape one. No imports, so plain `node --test` can load it — lib/autoIngest.ts
// pulls in `server-only` and the service-role client, which it cannot.
// (Same split as lib/offerEmailContent.ts; see the note on the EXCLUDED list in
// scripts/tests.mjs for what happens when logic stays behind a server-only import.)

/** Where to scrape, and how wide. `radiusKm` is the MATCHING cap — scraping a
 *  narrower area than we're willing to match across would leave a ring of
 *  addresses permanently uncovered: ingested nothing, matched nothing. */
export interface IngestRequest {
  country: string;
  city: string;
  radiusKm: number;
  /** Administrative region/state hint (e.g. "Balears"), read from the order's
   *  own delivery_address.region, to disambiguate same-named cities in
   *  different regions. null = no hint available. */
  region?: string | null;
  /** The order's own delivery_lat/lng — set by the caller (this function has
   *  no access to order columns, only the address object), so the geocoded
   *  result can be sanity-checked against where the order actually goes. */
  nearLat?: number | null;
  nearLng?: number | null;
}

/**
 * The area an order's delivery address names, or null if it names none.
 *
 * Deliberately the ADDRESS's own city (e.g. "Aix-les-Bains"), not the nearest
 * big city we happen to cover. Order #2000017 delivers to Aix-les-Bains with
 * our nearest florist 52km away in Grenoble — scraping "Grenoble" again would
 * find nothing new and skip as already-ingested, which is exactly the gap this
 * is meant to close.
 *
 * Kept identical to ingest-worker/src/autoIngest.ts::deliveryArea, so the
 * order page's manual button targets the same city the automatic path would.
 */
export function deliveryArea(deliveryAddress: unknown, radiusKm: number): IngestRequest | null {
  if (!deliveryAddress || typeof deliveryAddress !== "object") return null;
  const addr = deliveryAddress as Record<string, unknown>;
  const city = typeof addr.city === "string" ? addr.city.trim() : "";
  const country = typeof addr.country === "string" ? addr.country.trim() : "";
  if (!city || !country) return null;
  const region = typeof addr.region === "string" ? addr.region.trim() : "";
  return { country, city, radiusKm, region: region || null };
}

/**
 * Validate a `queue_ingest` payload before acting on it.
 *
 * The worker writes this onto an escalate approval and the dashboard's approval
 * executor reads it back, so it has crossed a JSONB round trip and a deploy
 * boundary. Returns null rather than a half-filled request — a scrape aimed at
 * "undefined, FR" costs real money to discover it was wrong.
 */
export function parseIngestRequest(v: unknown): IngestRequest | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const country = typeof o.country === "string" ? o.country.trim() : "";
  const city = typeof o.city === "string" ? o.city.trim() : "";
  const radiusKm = Number(o.radiusKm);
  if (!country || !city || !Number.isFinite(radiusKm) || radiusKm <= 0) return null;
  // region/nearLat/nearLng are carried through best-effort — a payload written
  // before this field existed (or by anything that omits it) still parses as a
  // normal, un-hinted request rather than being rejected.
  const region = typeof o.region === "string" ? o.region.trim() : "";
  const nearLat = typeof o.nearLat === "number" && Number.isFinite(o.nearLat) ? o.nearLat : null;
  const nearLng = typeof o.nearLng === "number" && Number.isFinite(o.nearLng) ? o.nearLng : null;
  return { country, city, radiusKm, region: region || null, nearLat, nearLng };
}
