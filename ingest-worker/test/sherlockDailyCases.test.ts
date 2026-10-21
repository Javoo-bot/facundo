// Sherlock's only source of real daily cases until the paid check exists:
// queue a `repair` job for every city with free-place-layer "Unchecked"
// shops. See src/sherlockDailyCases.ts for why this is narrower than
// repair.ts's general target set.
import { describe, it, expect, vi } from "vitest";
import {
  isSherlockDailyCasesMinute,
  sherlockDailyCasesGate,
  findFreeLayerDailyCaseCities,
  enqueueSherlockDailyCases,
} from "../src/sherlockDailyCases";
import { GARDEN_DB } from "../src/gardenActors";

describe("isSherlockDailyCasesMinute", () => {
  it("is true only at 06:10 UTC", () => {
    expect(isSherlockDailyCasesMinute(Date.UTC(2026, 9, 14, 6, 10))).toBe(true);
  });
  it("is false at every other time, including the other garden ticks", () => {
    expect(isSherlockDailyCasesMinute(Date.UTC(2026, 9, 14, 6, 11))).toBe(false);
    expect(isSherlockDailyCasesMinute(Date.UTC(2026, 9, 14, 4, 30))).toBe(false); // garden-daily report
    expect(isSherlockDailyCasesMinute(Date.UTC(2026, 9, 14, 0, 5))).toBe(false); // garden-actors minute
  });
});

describe("sherlockDailyCasesGate", () => {
  it("is open only for the garden database", () => {
    expect(sherlockDailyCasesGate({ SUPABASE_URL: `https://${GARDEN_DB}.supabase.co` })).toBe(true);
  });
  it("is closed for production (or anywhere else)", () => {
    expect(sherlockDailyCasesGate({ SUPABASE_URL: "https://bo-prod.supabase.co" })).toBe(false);
    expect(sherlockDailyCasesGate({ SUPABASE_URL: "" })).toBe(false);
  });
});

/** A `florists` chain that always resolves to `floristRows` (one page), and a
 * `cities` chain that resolves `cityRows` for an `.in("id", ids)` lookup. */
function makeCitiesSb(floristRows: Array<{ city_id: string | null }>, cityRows: Array<{ id: string; country: string; city: string }>) {
  const florists = {
    select: () => florists,
    not: () => florists,
    ilike: () => florists,
    is: () => florists,
    range: async () => ({ data: floristRows, error: null }),
  };
  const cities = {
    select: () => cities,
    in: async () => ({ data: cityRows, error: null }),
  };
  return {
    from: (table: string) => {
      if (table === "florists") return florists;
      if (table === "cities") return cities;
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
}

describe("findFreeLayerDailyCaseCities", () => {
  it("groups free-layer 'Unchecked' florists by city and names the city", () => {
    const sb = makeCitiesSb(
      [{ city_id: "c1" }, { city_id: "c1" }, { city_id: "c2" }],
      [
        { id: "c1", country: "Spain", city: "Girona" },
        { id: "c2", country: "France", city: "Lyon" },
      ]
    );
    return findFreeLayerDailyCaseCities(sb).then((rows) => {
      expect(rows.sort((a, b) => a.city.localeCompare(b.city))).toEqual([
        { country: "Spain", city: "Girona", florists: 2 },
        { country: "France", city: "Lyon", florists: 1 },
      ]);
    });
  });

  it("returns nothing when no florist is still 'Unchecked'", async () => {
    const sb = makeCitiesSb([], []);
    expect(await findFreeLayerDailyCaseCities(sb)).toEqual([]);
  });

  it("drops a city_id whose city row has vanished rather than crash", async () => {
    const sb = makeCitiesSb([{ city_id: "ghost" }], []);
    expect(await findFreeLayerDailyCaseCities(sb)).toEqual([]);
  });
});

/** A chain matching exactly enqueueSherlockDailyCases's "ingest_jobs" shapes:
 * select().eq().eq().in().limit(1); insert(). */
function makeIngestJobsSb(opts: { existing: Array<{ id: string }>; insertError?: unknown; lookupError?: unknown }) {
  const insert = vi.fn(async () => ({ error: opts.insertError ?? null }));
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    limit: async () => ({ data: opts.existing, error: opts.lookupError ?? null }),
    insert,
  };
  return { from: (table: string) => (expect(table).toBe("ingest_jobs"), chain), insert };
}

describe("enqueueSherlockDailyCases", () => {
  it("queues a repair job for a city with no job already queued or running", async () => {
    const jobs = makeIngestJobsSb({ existing: [] });
    const sb = makeCitiesAnd(jobs, [{ country: "Spain", city: "Girona", florists: 9 }]);
    const result = await enqueueSherlockDailyCases(sb);
    expect(result).toEqual({ queued: ["Girona"], skipped: [] });
    expect(jobs.insert).toHaveBeenCalledWith(
      expect.objectContaining({ country: "Spain", city: "Girona", mode: "repair", status: "queued" })
    );
  });

  it("skips a city that already has a queued or running repair job — never double-queues", async () => {
    const jobs = makeIngestJobsSb({ existing: [{ id: "job-1" }] });
    const sb = makeCitiesAnd(jobs, [{ country: "Spain", city: "Girona", florists: 9 }]);
    const result = await enqueueSherlockDailyCases(sb);
    expect(result).toEqual({ queued: [], skipped: ["Girona"] });
    expect(jobs.insert).not.toHaveBeenCalled();
  });

  it("skips (never throws) when the insert itself fails", async () => {
    const jobs = makeIngestJobsSb({ existing: [], insertError: { message: "db down" } });
    const sb = makeCitiesAnd(jobs, [{ country: "Spain", city: "Girona", florists: 9 }]);
    const result = await enqueueSherlockDailyCases(sb);
    expect(result).toEqual({ queued: [], skipped: ["Girona"] });
  });

  it("is a no-op with nothing to do", async () => {
    const jobs = makeIngestJobsSb({ existing: [] });
    const sb = makeCitiesAnd(jobs, []);
    expect(await enqueueSherlockDailyCases(sb)).toEqual({ queued: [], skipped: [] });
    expect(jobs.insert).not.toHaveBeenCalled();
  });
});

/** Stitches a pre-built `ingest_jobs` fake together with a `findFreeLayerDailyCaseCities`
 * stand-in — enqueueSherlockDailyCases only ever touches `ingest_jobs` itself; the
 * city list is injected by overriding `florists`/`cities` to produce exactly `cityRows`. */
function makeCitiesAnd(jobsSb: { from: (t: string) => unknown }, cityRows: Array<{ country: string; city: string; florists: number }>) {
  const floristRows = cityRows.map((c, i) => ({ city_id: `city-${i}` }));
  const cityNameRows = cityRows.map((c, i) => ({ id: `city-${i}`, country: c.country, city: c.city }));
  const citiesSb = makeCitiesSb(floristRows, cityNameRows);
  return {
    from: (table: string) => {
      if (table === "florists" || table === "cities") return (citiesSb as { from: (t: string) => unknown }).from(table);
      return jobsSb.from(table);
    },
  } as never;
}
