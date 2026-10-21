/** Adding a florist we already work with by hand, from a Google Places pick.
 *
 * The pure half — which city the shop belongs to, and what row to write. The
 * I/O (Places lookup, duplicate check, insert, token mint) is the route,
 * app/api/florists/create. Relative imports only (no "@/..."), so plain
 * `node --test` can reach it, same as lib/floristAccept.ts.
 *
 * GOVERNING RULE: the row this produces must be INDISTINGUISHABLE from one the
 * ingest wrote. Not similar — identical in shape. That is what lets every
 * downstream system (matching, scoring, enrichment) stay ignorant that manual
 * florists exist. The proof it works: a row built here is automatically a valid
 * enrichment target for the worker's repair mode, with no special-casing at
 * all, purely because it has a real website_url and no enrichment_notes yet.
 *
 * Two markers are deliberate and are NOT branching: `source = 'existing'`
 * (which the matcher already weights, via match_weight_source) and `added_by`.
 */

import { haversineKm } from "./geo.ts";
import type { BusinessHours } from "./businessHours.ts";

/** Radius assumed for a city row that predates radius-based scraping, where
 * `radius_km` is null. Matches the ingest default; only used to decide city
 * membership, never written anywhere. */
const ASSUMED_CITY_RADIUS_KM = 15;

/** Marks a florist whose `place_id` we invented because the shop has no Google
 * listing. Greppable on purpose: it is the one population where the id is not a
 * real Google key, so any future reconciliation can find them in one query. */
export const MANUAL_PLACE_ID_PREFIX = "MANUAL-";

/** True for a row whose place_id we minted rather than got from Google. */
export function isManualPlaceId(placeId: string | null | undefined): boolean {
  return !!placeId?.startsWith(MANUAL_PLACE_ID_PREFIX);
}

export interface CityRow {
  id: string;
  country: string;
  city: string;
  center_lat: number;
  center_lng: number;
  radius_km: number | null;
}

/**
 * The city this shop belongs to, or null if none covers it.
 *
 * The rule is not an arbitrary distance threshold: a shop belongs to a city
 * when it falls within that city's OWN ingest radius — precisely the set of
 * shops that city's scrape would have found. That is what makes the
 * `(city_id, place_id)` dedup key correct later: when we do scrape the city,
 * the shop is already filed under the city that will find it, so the upsert
 * updates our row instead of creating a twin.
 *
 * Nearest wins when radii overlap, which is the same tie-break a human would
 * make and keeps the choice stable as cities are added.
 */
export function pickCity(
  shop: { lat: number; lng: number },
  cities: CityRow[]
): CityRow | null {
  const covering = cities
    .map((c) => ({
      city: c,
      km: haversineKm(shop.lat, shop.lng, c.center_lat, c.center_lng),
      radius: c.radius_km ?? ASSUMED_CITY_RADIUS_KM,
    }))
    // `km` is null when any coordinate is missing or non-finite. Testing it
    // explicitly is load-bearing: `null <= 15` is TRUE in JavaScript, so a city
    // with a broken center would otherwise swallow every shop at "0 km".
    .filter((c): c is { city: CityRow; km: number; radius: number } => c.km != null && c.km <= c.radius)
    .sort((a, b) => a.km - b.km);

  return covering[0]?.city ?? null;
}

export interface ManualFloristInput {
  /** A real Google id when the shop was picked from Maps — which is what keeps
   * the row dedup-compatible with a future scrape — or a `MANUAL-` one we
   * minted for a shop that has no listing to pick. */
  place_id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  website_url: string | null;
  /** Places `nationalPhoneNumber`; normalized by the caller with the same
   * lib/phone.ts::normalizePhone the ingest row builder uses. */
  phone_web: string | null;
  business_hours: BusinessHours | null;
  /** What only the staff member knows. */
  phone_mobile: string | null;
  owner_name: string | null;
  email: string | null;
  /** So the row clears ingest-worker/src/match.ts::passesHardFilter, which
   * rejects any florist missing either of these. Without them the florist
   * completes the join form and then silently receives nothing. */
  delivery_radius_km: number;
  trust_tier: string;
  lifecycle_stage: string;
  source_notes: string | null;
  added_by: string;
}

/**
 * The `florists` insert row.
 *
 * `joined_at` is deliberately ABSENT. The accept page treats a non-null
 * `joined_at` as "already in the network" and refuses to show the form, so
 * setting it here would hand the florist a link that greets them with a dead
 * end. They join by completing the form; that is what sets it.
 *
 * `enrichment_notes` is likewise absent — left null on purpose, because null is
 * exactly what marks the row as never-enriched and therefore picks it up in the
 * worker's repair sweep. See ingest-worker/src/repair.ts::needsRepair.
 */
export function buildManualFloristRow(
  input: ManualFloristInput,
  cityId: string
): Record<string, unknown> {
  return {
    city_id: cityId,
    place_id: input.place_id,
    name: input.name,
    address: input.address,
    lat: input.lat,
    lng: input.lng,
    website_url: input.website_url,
    has_website: !!input.website_url,
    phone_web: input.phone_web,
    phone_mobile: input.phone_mobile,
    owner_name: input.owner_name,
    email: input.email,
    business_hours: input.business_hours,
    delivery_radius_km: input.delivery_radius_km,
    trust_tier: input.trust_tier,
    lifecycle_stage: input.lifecycle_stage,
    // Not 'new': we are not discovering these shops, we already work with them.
    // The matcher weights this (match_weight_source), so saying so ranks them
    // ahead of cold prospects, which is correct.
    source: "existing",
    source_notes: input.source_notes,
    added_by: input.added_by,
  };
}

export interface ValidationFailure {
  ok: false;
  error: string;
}

/** Guards the things a bad dialog submission could otherwise write. The route
 * re-checks nothing else: Places supplies the geography, and the duplicate
 * check needs the database. */
export function validateManualFlorist(
  body: Record<string, unknown>
): { ok: true; values: ManualFloristInput } | ValidationFailure {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");

  // OFF-MAPS SHOPS. Plenty of real florists have no Google listing at all —
  // older shops, ones inside a market hall, ones whose listing was never
  // claimed. Requiring a Places pick locked those out entirely, so `place_id`
  // is synthesised when none is supplied.
  //
  // Synthesising it is safe HERE and nowhere else. The standing objection is
  // that a fake key breaks `(city_id, place_id)` dedup against a future scrape
  // — but a shop absent from Maps is a shop no scrape will ever return, so
  // there is nothing to collide with. The prefix keeps them greppable if that
  // assumption ever needs revisiting.
  const place_id = str("place_id") || `${MANUAL_PLACE_ID_PREFIX}${crypto.randomUUID()}`;

  const name = str("name");
  if (!name) return { ok: false, error: "name must be a non-empty string." };

  const lat = body.lat;
  const lng = body.lng;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    // Not negotiable, even for an off-maps shop. The matcher loads candidates
    // by a bounding box around the delivery point (lib/lifecycle.ts), so a
    // florist with no coordinates is invisible to it — they would sit in the
    // roster looking healthy and never receive a single order. If the business
    // is not on Maps, its STREET still is: pick the address instead.
    return { ok: false, error: "Coordinates are required — pick the shop, or at least its street address, from the Maps list." };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: "lat and lng must be within valid coordinate ranges." };
  }

  const radius = body.delivery_radius_km;
  if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0 || radius > 200) {
    return { ok: false, error: "delivery_radius_km must be a positive number of kilometres." };
  }

  // A florist we cannot reach is a florist who never sees an order. Offers go
  // out by SMS and email (lib/reachoutSend.ts); with neither we would create a
  // shop that looks healthy in the roster and is unreachable in practice — the
  // same class of silent failure as missing coordinates or a missing tier.
  const phone_mobile = str("phone_mobile") || null;
  const email = str("email") || null;
  if (!phone_mobile && !email) {
    return { ok: false, error: "Give a mobile number or an email — we need at least one way to send them orders." };
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "That email doesn't look right." };
  }

  const trust_tier = str("trust_tier");
  if (!trust_tier) return { ok: false, error: "trust_tier is required so the florist can be matched." };

  const lifecycle_stage = str("lifecycle_stage");
  if (!lifecycle_stage) return { ok: false, error: "lifecycle_stage is required." };

  const added_by = str("added_by");
  if (!added_by) return { ok: false, error: "added_by is required." };

  return {
    ok: true,
    values: {
      place_id,
      name,
      address: str("address") || null,
      lat,
      lng,
      website_url: str("website_url") || null,
      phone_web: str("phone_web") || null,
      phone_mobile,
      owner_name: str("owner_name") || null,
      email,
      business_hours: (body.business_hours as BusinessHours | null) ?? null,
      delivery_radius_km: radius,
      trust_tier,
      lifecycle_stage,
      source_notes: str("source_notes") || null,
      added_by,
    },
  };
}
