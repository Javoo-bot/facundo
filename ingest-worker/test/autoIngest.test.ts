// Ingest-on-empty: deliveryArea names the area to scrape, queueIngestForArea
// queues it idempotently. See supabase/migrations/2026-08-25-ingest-region-
// disambiguation.sql — a job's (country, city, region) idempotency key exists
// because order #2000031 (San Carlos, Balears) needed a region-hinted retry
// after a pre-disambiguation region='' scrape had already "succeeded" for the
// wrong San Carlos, ~900km away.
import { describe, it, expect, vi } from "vitest";
import { deliveryArea, queueIngestForArea, type IngestRequest } from "../src/autoIngest";

describe("deliveryArea", () => {
  it("includes region when the delivery address carries one", () => {
    const area = deliveryArea({ city: "San Carlos", country: "ES", region: "Balears" }, 20);
    expect(area).toEqual({ country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears" });
  });

  it("region is null when the address carries none", () => {
    const area = deliveryArea({ city: "Lyon", country: "FR" }, 20);
    expect(area?.region).toBeNull();
  });

  it("trims region and treats blank as no hint", () => {
    expect(deliveryArea({ city: "Lyon", country: "FR", region: "  " }, 20)?.region).toBeNull();
    expect(deliveryArea({ city: "Lyon", country: "FR", region: " Rhône " }, 20)?.region).toBe("Rhône");
  });

  it("no city or country still means nothing to scrape, region or not", () => {
    expect(deliveryArea({ country: "FR", region: "Rhône" }, 20)).toBeNull();
  });
});

/** Chainable stub matching exactly the "ingest_jobs" call shapes
 * queueIngestForArea uses: select().eq().eq().eq().in().limit(1); insert(). */
function makeIngestJobsSb(opts: {
  existing: Array<{ id: string; status: string }>;
  insertError?: unknown;
  lookupError?: unknown;
  throwOnInsert?: boolean;
}) {
  const eqCalls: string[][] = [];
  let currentEq: string[] = [];
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    if (opts.throwOnInsert) throw new Error("network down");
    return { error: opts.insertError ?? null, row };
  });
  const sb = {
    from(table: string) {
      expect(table).toBe("ingest_jobs");
      currentEq = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          currentEq.push(`${col}=${v}`);
          return chain;
        },
        in: () => chain,
        limit: async () => {
          eqCalls.push(currentEq);
          return { data: opts.existing, error: opts.lookupError ?? null };
        },
        insert,
      };
      return chain;
    },
  };
  return { sb, eqCalls, insert };
}

describe("queueIngestForArea", () => {
  it("filters the idempotency lookup on region — a succeeded WRONG-region job never blocks a fresh hinted retry", async () => {
    // The San Carlos bug, exactly: a pre-disambiguation job with region=''
    // already 'succeeded' for the wrong San Carlos. A region-hinted retry for
    // the real one must not see that as "already-ingested".
    const { sb, eqCalls, insert } = makeIngestJobsSb({ existing: [] }); // .eq("region","Balears") finds nothing
    const req: IngestRequest = { country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears" };

    const outcome = await queueIngestForArea(sb as any, req);

    expect(outcome).toBe("queued");
    expect(eqCalls[0]).toContain("region=Balears");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ region: "Balears", country: "ES", city: "San Carlos" })
    );
  });

  it("still blocks on an existing succeeded job for the SAME region", async () => {
    const { sb } = makeIngestJobsSb({ existing: [{ id: "job-1", status: "succeeded" }] });
    const req: IngestRequest = { country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears" };

    expect(await queueIngestForArea(sb as any, req)).toBe("already-ingested");
  });

  it("no region hint: filters on region='' (the no-hint convention)", async () => {
    const { sb, eqCalls } = makeIngestJobsSb({ existing: [] });
    const req: IngestRequest = { country: "FR", city: "Lyon", radiusKm: 20 };

    await queueIngestForArea(sb as any, req);

    expect(eqCalls[0]).toContain("region=");
  });

  it("inserts near_lat/near_lng when provided", async () => {
    const { sb, insert } = makeIngestJobsSb({ existing: [] });
    const req: IngestRequest = { country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears", nearLat: 39.033, nearLng: 1.564 };

    await queueIngestForArea(sb as any, req);

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ near_lat: 39.033, near_lng: 1.564 }));
  });

  it("a queued/running job for the same region still blocks", async () => {
    const { sb } = makeIngestJobsSb({ existing: [{ id: "job-1", status: "running" }] });
    const req: IngestRequest = { country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears" };

    expect(await queueIngestForArea(sb as any, req)).toBe("already-running");
  });

  // The 2026-08-25 regression, pinned. The region/near_lat migration had not
  // been applied to the database, so every insert failed on the unknown column
  // — and the old code returned "already-running", which reads in order_events
  // as healthy dedupe. Autoscrape was dead for two days and nothing said so.
  describe("a failed queue is never reported as a dedupe hit", () => {
    const req: IngestRequest = { country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears" };

    it("an insert error is 'error', not 'already-running'", async () => {
      const { sb } = makeIngestJobsSb({
        existing: [],
        insertError: { code: "PGRST204", message: "Could not find the 'region' column of 'ingest_jobs' in the schema cache" },
      });

      expect(await queueIngestForArea(sb as any, req)).toBe("error");
    });

    it("a failed lookup is 'error' and never falls through to the insert", async () => {
      // Treating a failed lookup as "nothing found" would bypass the whole
      // idempotency guard and bill a second Apify run for an area already
      // being scraped.
      const { sb, insert } = makeIngestJobsSb({
        existing: [],
        lookupError: { code: "42703", message: "column ingest_jobs.region does not exist" },
      });

      expect(await queueIngestForArea(sb as any, req)).toBe("error");
      expect(insert).not.toHaveBeenCalled();
    });

    it("a thrown error still fails closed, but as 'error'", async () => {
      const { sb } = makeIngestJobsSb({ existing: [], throwOnInsert: true });

      expect(await queueIngestForArea(sb as any, req)).toBe("error");
    });
  });
});
