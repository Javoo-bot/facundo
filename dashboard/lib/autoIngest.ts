import "server-only";

import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { type IngestRequest } from "@/lib/ingestArea";

// The pure half lives in lib/ingestArea.ts so it can be unit-tested under plain
// `node --test`; re-exported here so callers have one import to reach for.
export { deliveryArea, parseIngestRequest, type IngestRequest } from "@/lib/ingestArea";

// Queue a scrape of a delivery area that had no florist in range.
//
// The worker queues these itself in `auto` mode (ingest-worker/src/autoIngest.ts).
// This is the `semi` half: the escalate approval carries a `queue_ingest`
// payload, and approving the escalation is what spends the money. Same guards,
// same row shape — it is only here because the two run in different runtimes and
// this side is pure I/O, no matching logic to keep in step.

// "error" = the queue attempt itself failed, and is deliberately NOT folded into
// "already-running". Conflating them is what hid the 2026-08-25 breakage: the
// region/near_lat migration had not been applied, every insert failed on the
// unknown column, and the failure surfaced as a benign-looking dedupe hit. Kept
// in step with ingest-worker/src/autoIngest.ts::QueueOutcome.
export type QueueOutcome = "queued" | "already-running" | "already-ingested" | "invalid" | "error";

/** What we already know about scraping this area — so the order page can say
 *  "scraped 3 weeks ago, found 0" rather than offering a button that silently
 *  no-ops. `null` means we have never looked here. */
export interface AreaJob {
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  floristCount: number | null;
  radiusKm: number | null;
  lastLine: string | null;
}

export async function lookupAreaJob(
  admin: ReturnType<typeof createServiceClient>,
  area: { country: string; city: string; region?: string | null }
): Promise<AreaJob | null> {
  try {
    // Most recent first: a failed retry followed by a success should read as
    // "succeeded", and vice versa.
    const { data, error } = await admin
      .from("ingest_jobs")
      .select("status, started_at, finished_at, florist_count, radius_km, last_line")
      .eq("country", area.country)
      .eq("city", area.city)
      .eq("region", area.region ?? "")
      .order("started_at", { ascending: false })
      .limit(1);
    // Display-only, so a failure still degrades to "we have never looked here" —
    // but it gets reported rather than being indistinguishable from the truth.
    if (error) captureError("autoIngest.lookupAreaJob", error);
    const row = data?.[0];
    if (!row) return null;
    return {
      status: row.status as string,
      startedAt: (row.started_at as string) ?? null,
      finishedAt: (row.finished_at as string) ?? null,
      floristCount: (row.florist_count as number) ?? null,
      radiusKm: (row.radius_km as number) ?? null,
      lastLine: (row.last_line as string) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Queue an ingest unless one is already queued/running for this area, or one has
 * already succeeded for it (in which case the area really is empty of florists
 * we can use, and re-scraping would just spend money to rediscover that).
 *
 * Never throws — failing to queue must not fail the approval that called it.
 */
export async function queueIngestForArea(
  admin: ReturnType<typeof createServiceClient>,
  req: IngestRequest,
  opts: { force?: boolean } = {}
): Promise<QueueOutcome> {
  try {
    const { data: existing, error: lookupError } = await admin
      .from("ingest_jobs")
      .select("id, status")
      .eq("country", req.country)
      .eq("city", req.city)
      .eq("region", req.region ?? "")
      .in("status", ["queued", "running", "succeeded"])
      .limit(1);
    // A failed lookup is NOT "nothing found". Falling through to the insert on a
    // transient error would bypass the idempotency guard entirely and bill a
    // second Apify run for an area already being scraped.
    if (lookupError) {
      captureError("autoIngest.lookup", lookupError);
      return "error";
    }
    const found = existing?.[0]?.status as string | undefined;
    // A job in flight blocks even a forced request: a second concurrent scrape
    // of the same area is pure waste, not a different answer.
    if (found === "queued" || found === "running") return "already-running";
    // "We already looked here" is the right default for AUTOMATIC firing. A
    // human clicking the button on an order page is explicitly saying "look
    // again" — coverage changes, and the first scrape may have run at a
    // narrower radius — so `force` overrides only this arm.
    //
    // The region filter above is load-bearing beyond that: a previously-
    // `succeeded` job for the WRONG region (e.g. a pre-disambiguation
    // region='' row for a city name that collides across regions) must never
    // block a fresh, correctly-hinted retry — that's exactly the San Carlos
    // bug (order #2000031).
    if (found === "succeeded" && !opts.force) return "already-ingested";

    const { error } = await admin.from("ingest_jobs").insert({
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
