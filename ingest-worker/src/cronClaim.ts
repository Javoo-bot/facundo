import { captureError } from "./monitor";
import type { Env, CityJobMessage, IngestJobMode } from "./types";
import { MAX_JOBS_PER_SWEEP, MAX_IN_FLIGHT_INGEST_JOBS } from "./config";

export function messageFromIngestJob(row: IngestJobRow): CityJobMessage {
  return {
    jobId: row.id,
    country: row.country,
    city: row.city,
    radiusKm: row.radius_km ?? 25,
    limit: row.limit_per_keyword ?? 50,
    resetExisting: !!row.reset_existing,
    mode: row.mode === "repair" ? "repair" : "city",
    region: row.region ?? null,
    nearLat: row.near_lat ?? null,
    nearLng: row.near_lng ?? null,
  };
}

export type IngestJobRow = {
  id: string;
  country: string;
  city: string;
  radius_km: number | null;
  limit_per_keyword: number | null;
  reset_existing?: boolean | null;
  mode?: IngestJobMode | null;
  region?: string | null;
  near_lat?: number | null;
  near_lng?: number | null;
};

export async function claimQueuedIngestJobs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client type differs between runtime and tests
  sb: any,
  env: Pick<Env, "INGEST_QUEUE">,
): Promise<void> {
  try {
    // Claim against HEADROOM, not just a per-tick cap. A per-tick cap alone
    // bounds nothing: the queue consumer starts a Workflow and acks without
    // waiting for it, so 20 claims a minute against 5-6 minute cities means
    // in-flight work grows every tick until the batch runs out. Beyond
    // MAX_IN_FLIGHT_INGEST_JOBS that overruns Apify's account memory ceiling
    // and new runs cannot start at all — see the constant's comment.
    //
    // The stale-job reaper runs immediately before this in the same tick, so a
    // job whose claimer died has already been released and is not counted here.
    const { count, error: countError } = await sb
      .from("ingest_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running");

    // Fail CLOSED. Claiming blind on a failed count is the one outcome worth
    // avoiding: it is how the ceiling gets overrun, and an overrun fails real
    // runs and spends real money. Skipping a tick costs 60 seconds, is visible
    // (rows stay `queued` on /jobs), and self-heals on the next tick.
    if (countError) throw countError;

    const headroom = MAX_IN_FLIGHT_INGEST_JOBS - (count ?? 0);
    if (headroom <= 0) return;

    const { data } = await sb
      .from("ingest_jobs")
      .select("id, country, city, radius_km, limit_per_keyword, reset_existing, mode, region, near_lat, near_lng")
      .eq("status", "queued")
      .limit(Math.min(headroom, MAX_JOBS_PER_SWEEP));
    for (const row of (data ?? []) as IngestJobRow[]) {
      const { data: claimed } = await sb
        .from("ingest_jobs")
        .update({ status: "running" })
        .eq("id", row.id)
        .eq("status", "queued")
        .select("id");
      if (!claimed || claimed.length === 0) continue; // lost the race — someone else claimed
      await env.INGEST_QUEUE.send(messageFromIngestJob(row));
    }
  } catch (e) {
    captureError("cron.claim_ingest_jobs", e);
  }
}
