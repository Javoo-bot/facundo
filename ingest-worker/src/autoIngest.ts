// Ingest-on-empty: when an order has no florist within the matching cap, queue
// a scrape of that delivery area so the NEXT order there has somebody — and, if
// the scrape finds anyone, re-match this one too.
//
// The order never waits on it. An ingest is Apify + LLM enrichment of 50-150
// shops and takes minutes, so the order escalates to CX immediately and the
// ingest runs behind it. CX either places it by hand (fine) or finds fresh
// candidates waiting when they look (better).
//
// Mode-gated like everything else in the loop:
//   auto   — queues the ingest unattended
//   semi   — attaches the request to the escalate approval, so approving the
//            escalation is what spends the money (see dashboard/lib/
//            approvalExecutors.ts). It cannot file its own approval row:
//            order_approvals has a unique index allowing ONE pending row per
//            order, and the escalation already holds it.
//   manual — records the gap as an order event and does nothing else.

import type { SupabaseClient } from "@supabase/supabase-js";
import { captureError } from "./monitor";

/** Where to look, and how wide. `radiusKm` is the matching cap — ingesting a
 *  narrower area than we're willing to match across would leave a ring of
 *  addresses permanently uncovered. */
export interface IngestRequest {
  country: string;
  city: string;
  radiusKm: number;
  /** Administrative region/state hint (e.g. "Balears"), read from the order's
   *  own delivery_address.region, to disambiguate same-named cities in the
   *  geocode query. */
  region?: string | null;
  /** The order's own delivery_lat/lng, so the geocoded result can be
   *  sanity-checked against where the order actually goes rather than
   *  trusting Nominatim's top-ranked match blindly. */
  nearLat?: number | null;
  nearLng?: number | null;
}

export type QueueOutcome =
  | "queued"
  | "already-running"   // a job for this area is queued/running — the guard that
                        // stops ten orders in one town firing ten Apify runs
  | "already-ingested"  // we've already scraped here; it really is empty
  | "no-area"           // the order's address carries no city/country to scrape
  | "error";            // the queue attempt itself failed — NOT a dedupe hit.
                        // Its own outcome because conflating the two is what hid
                        // the 2026-08-25 breakage: the region/near_lat migration
                        // had not been applied, every insert failed on the
                        // unknown column, and the failure was reported as
                        // "already-running" — a benign-looking word that made
                        // "autoscrape never fires" indistinguishable from
                        // "autoscrape correctly deduped" in order_events.

/** The delivery address's own city + country code, or null if either is
 *  missing. Deliberately the ADDRESS's city (e.g. "Issy-les-Moulineaux"), not
 *  the nearest big city we happen to cover — scraping "Paris" again would find
 *  nothing new and skip as already-ingested, which is precisely the failure
 *  this exists to fix. */
export function deliveryArea(
  deliveryAddress: unknown,
  radiusKm: number
): IngestRequest | null {
  const addr = (deliveryAddress ?? {}) as Record<string, unknown>;
  const city = typeof addr.city === "string" ? addr.city.trim() : "";
  const country = typeof addr.country === "string" ? addr.country.trim() : "";
  if (!city || !country) return null;
  const region = typeof addr.region === "string" ? addr.region.trim() : "";
  return { country, city, radiusKm, region: region || null };
}

/**
 * Queue an ingest for `req`, unless we already have or already are.
 *
 * Idempotency is the load-bearing part, not the policy: `orders/updated` fires
 * on any mutation and the reconcile sweep re-reads parked orders hourly, so
 * without these guards one uncovered town would fire an Apify run per event.
 *
 * Never throws — a failure to queue must not fail the match that called it.
 */
export async function queueIngestForArea(
  sb: SupabaseClient,
  req: IngestRequest
): Promise<QueueOutcome> {
  try {
    const { data: existing, error: lookupError } = await sb
      .from("ingest_jobs")
      .select("id, status")
      .eq("country", req.country)
      .eq("city", req.city)
      .eq("region", req.region ?? "")
      .in("status", ["queued", "running", "succeeded"])
      .limit(1);
    // A failed lookup is NOT "nothing found". Falling through to the insert on
    // a transient error would bypass the whole idempotency guard and bill a
    // second Apify run for an area already being scraped.
    if (lookupError) {
      captureError("autoIngest.lookup", lookupError);
      return "error";
    }
    const found = existing?.[0]?.status as string | undefined;
    if (found === "queued" || found === "running") return "already-running";
    // A previous successful scrape means the area really is empty of florists we
    // can use, not that we never looked. Re-running it would spend money to
    // rediscover that. Staff can always force one from /ingest.
    //
    // The region filter above is load-bearing here: a previously-`succeeded`
    // job for the WRONG region (e.g. a pre-disambiguation region='' row for a
    // city name that collides across regions) must never block a fresh,
    // correctly-hinted retry.
    if (found === "succeeded") return "already-ingested";

    // Same shape /api/ingest writes in queue mode: the worker's per-minute cron
    // claims `queued` rows and runs CityIngestWorkflow. keywords/language null =
    // "derive per country".
    const { error } = await sb.from("ingest_jobs").insert({
      country: req.country,
      city: req.city,
      radius_km: req.radiusKm,
      limit_per_keyword: 100,
      keywords: null,
      language: null,
      reset_existing: false,
      status: "queued",
      region: req.region ?? "",
      near_lat: req.nearLat ?? null,
      near_lng: req.nearLng ?? null,
    });
    // `ingest_jobs` carries no unique constraint beyond its primary key, so
    // there is no 23505 a concurrent insert could raise here — every error on
    // this write is a real failure (a missing column, a bad grant, PostgREST
    // being down), never a benign dedupe.
    if (error) {
      captureError("autoIngest.insert", error);
      return "error";
    }
    return "queued";
  } catch (err) {
    // Still fails closed — nothing is queued — but says so honestly instead of
    // borrowing the dedupe outcome's name.
    captureError("autoIngest.queue", err);
    return "error";
  }
}

/**
 * After a successful ingest, re-match the orders that escalated for want of
 * coverage in exactly that area.
 *
 * Only orders still `escalated` are touched, and only those whose
 * `awaiting_ingest` event names this country+city — an order CX has already
 * placed by hand has moved on and must not be rewound. `rematch` re-runs the
 * normal match and returns how many candidates it found; an order that still
 * finds nobody simply stays escalated.
 *
 * Returns the order ids that came back with candidates.
 */
export async function rematchOrdersAwaitingArea(
  sb: SupabaseClient,
  area: { country: string; city: string },
  rematch: (orderId: string) => Promise<number>
): Promise<string[]> {
  const recovered: string[] = [];
  try {
    const { data: events } = await sb
      .from("order_events")
      .select("order_id, payload")
      .eq("type", "awaiting_ingest")
      .order("created_at", { ascending: false })
      .limit(500);
    const waiting = new Set(
      (events ?? [])
        .filter((e) => {
          const p = (e.payload ?? {}) as Record<string, unknown>;
          return p.country === area.country && p.city === area.city;
        })
        .map((e) => e.order_id as string)
    );
    if (waiting.size === 0) return recovered;

    const { data: orders } = await sb
      .from("orders")
      .select("id")
      .in("id", [...waiting])
      .eq("status", "escalated")
      .is("deleted_at", null);

    for (const o of orders ?? []) {
      try {
        const found = await rematch(o.id as string);
        if (found > 0) recovered.push(o.id as string);
      } catch {
        // One order's re-match failing must not abandon the rest.
      }
    }
  } catch {
    // Best-effort: a successful ingest is still a successful ingest.
  }
  return recovered;
}
