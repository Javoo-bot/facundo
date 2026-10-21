import { describe, expect, it, vi } from "vitest";

vi.mock("../src/monitor", () => ({ captureError: vi.fn() }));

const { claimQueuedIngestJobs } = await import("../src/cronClaim");
const { captureError } = await import("../src/monitor");
const { MAX_IN_FLIGHT_INGEST_JOBS, MAX_JOBS_PER_SWEEP } = await import("../src/config");

/** A Supabase stand-in shaped like the two queries the claim makes: a
 * head+count of `running`, then a select of `queued` rows it tries to flip.
 * `runningCount` drives the first, `queued` the second. */
function fakeSupabase(opts: {
  runningCount?: number;
  countError?: unknown;
  queued?: Record<string, unknown>[];
  claimable?: (id: string) => boolean;
}) {
  const { runningCount = 0, countError = null, queued = [], claimable = () => true } = opts;
  let sawLimit: number | null = null;

  const client = {
    get lastLimit() {
      return sawLimit;
    },
    from(table: string) {
      expect(table).toBe("ingest_jobs");
      let status = "";
      let currentId = "";
      let isCount = false;
      const builder: Record<string, unknown> = {
        select(_cols: string, opt?: { count?: string; head?: boolean }) {
          if (opt?.head) isCount = true;
          return builder;
        },
        eq(col: string, value: string) {
          if (col === "status") status = value;
          if (col === "id") currentId = value;
          return builder;
        },
        update() {
          return builder;
        },
        limit(n: number) {
          sawLimit = n;
          return Promise.resolve({ data: queued });
        },
        // The count query is awaited without .limit(), and so is the update.
        then(resolve: (v: unknown) => void) {
          if (isCount && status === "running") {
            resolve({ count: runningCount, error: countError });
            return;
          }
          resolve({ data: claimable(currentId) ? [{ id: currentId }] : [] });
        },
      };
      return builder;
    },
  };
  return client;
}

describe("claimQueuedIngestJobs", () => {
  it("captures claim-list failures instead of throwing out of the cron tick", async () => {
    const sb = {
      from() {
        throw new Error("supabase down");
      },
    };
    const env = { INGEST_QUEUE: { send: vi.fn() } };

    await expect(claimQueuedIngestJobs(sb, env as any)).resolves.toBeUndefined();
    expect(captureError).toHaveBeenCalledWith("cron.claim_ingest_jobs", expect.any(Error));
    expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
  });

  it("queues only rows it successfully claims", async () => {
    const sb = fakeSupabase({
      queued: [
        { id: "job-1", country: "ES", city: "Girona", radius_km: 10, limit_per_keyword: 20, reset_existing: false, mode: "florists" },
        { id: "job-2", country: "FR", city: "Paris", radius_km: null, limit_per_keyword: null, reset_existing: true, mode: "venues" },
      ],
      claimable: (id) => id === "job-1",
    });
    const env = { INGEST_QUEUE: { send: vi.fn() } };

    await claimQueuedIngestJobs(sb, env as any);

    expect(env.INGEST_QUEUE.send).toHaveBeenCalledTimes(1);
    expect(env.INGEST_QUEUE.send).toHaveBeenCalledWith({
      jobId: "job-1",
      country: "ES",
      city: "Girona",
      radiusKm: 10,
      limit: 20,
      resetExisting: false,
      mode: "city",
      region: null,
      nearLat: null,
      nearLng: null,
    });
  });

  it("carries region/near_lat/near_lng through to the queued message", async () => {
    const sb = fakeSupabase({
      queued: [
        { id: "job-1", country: "ES", city: "San Carlos", radius_km: 20, limit_per_keyword: 100, reset_existing: false, mode: "city", region: "Balears", near_lat: 39.033, near_lng: 1.564 },
      ],
    });
    const env = { INGEST_QUEUE: { send: vi.fn() } };

    await claimQueuedIngestJobs(sb, env as any);

    expect(env.INGEST_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ region: "Balears", nearLat: 39.033, nearLng: 1.564 })
    );
  });

  // ---- the in-flight ceiling -----------------------------------------------
  // The queue consumer starts a Workflow and acks without waiting for it, so
  // nothing else in the pipeline bounds how many cities run at once. Past
  // MAX_IN_FLIGHT_INGEST_JOBS, Apify refuses to start the run at all (account
  // memory), so this cap is the only thing standing between a 41-city batch and
  // a pile of cities failing at scrape-start.

  it("claims only up to the headroom below the in-flight ceiling", async () => {
    const running = MAX_IN_FLIGHT_INGEST_JOBS - 3;
    const sb = fakeSupabase({ runningCount: running, queued: [] });
    const env = { INGEST_QUEUE: { send: vi.fn() } };

    await claimQueuedIngestJobs(sb, env as any);

    expect(sb.lastLimit).toBe(3);
  });

  it("claims nothing when the ceiling is already full", async () => {
    const sb = fakeSupabase({
      runningCount: MAX_IN_FLIGHT_INGEST_JOBS,
      queued: [{ id: "job-1", country: "ES", city: "Soria", radius_km: 30, limit_per_keyword: 200 }],
    });
    const env = { INGEST_QUEUE: { send: vi.fn() } };

    await claimQueuedIngestJobs(sb, env as any);

    expect(sb.lastLimit).toBeNull(); // never even asked for queued rows
    expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
  });

  it("claims nothing when running somehow exceeds the ceiling", async () => {
    // Can happen after the constant is lowered while work is already in flight.
    const sb = fakeSupabase({ runningCount: MAX_IN_FLIGHT_INGEST_JOBS + 5 });
    const env = { INGEST_QUEUE: { send: vi.fn() } };

    await claimQueuedIngestJobs(sb, env as any);

    expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
  });

  it("never claims more than the per-tick cap, however much headroom there is", async () => {
    // Belt to the ceiling's braces: if the ceiling is ever raised above the
    // sweep cap, a single tick still must not claim the world.
    const sb = fakeSupabase({ runningCount: 0, queued: [] });
    const env = { INGEST_QUEUE: { send: vi.fn() } };

    await claimQueuedIngestJobs(sb, env as any);

    expect(sb.lastLimit).toBeLessThanOrEqual(MAX_JOBS_PER_SWEEP);
    expect(sb.lastLimit).toBe(Math.min(MAX_IN_FLIGHT_INGEST_JOBS, MAX_JOBS_PER_SWEEP));
  });

  // Fails CLOSED on purpose: claiming blind is how the Apify ceiling gets
  // overrun, and an overrun fails real runs and spends real money. A skipped
  // tick costs 60 seconds and self-heals.
  it("claims nothing, and reports, when the in-flight count cannot be read", async () => {
    const sb = fakeSupabase({ countError: new Error("count failed"), queued: [{ id: "job-1" }] });
    const env = { INGEST_QUEUE: { send: vi.fn() } };

    await expect(claimQueuedIngestJobs(sb, env as any)).resolves.toBeUndefined();

    expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledWith("cron.claim_ingest_jobs", expect.anything());
  });
});
