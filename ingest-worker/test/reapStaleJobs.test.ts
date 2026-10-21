// Nothing reaped stale `running` ingest jobs, so a claimer that died hard left
// its row running forever. Two Sitges jobs sat that way for 29 days, wedged at
// "[6/7] Enriching…" — and because autoIngest.ts::queueIngestForArea treats a
// running job as "already in progress", that permanently blocked Sitges from
// being re-ingested by anything, including the order page's Scrape button.
import { describe, it, expect, vi } from "vitest";
import { staleRunningCutoffIso, reapStaleRunningJobs } from "../src/jobs";
import { STALE_RUNNING_JOB_HOURS } from "../src/config";

const NOW = Date.parse("2026-08-07T09:00:00.000Z");

describe("staleRunningCutoffIso", () => {
  it("is the configured number of hours before now", () => {
    expect(staleRunningCutoffIso(NOW)).toBe(
      new Date(NOW - STALE_RUNNING_JOB_HOURS * 3600_000).toISOString()
    );
  });

  it("leaves a normal run well clear of the cutoff", () => {
    // Palma's 276-place ingest took ~15 minutes; the threshold must never
    // catch a job that is merely slow.
    const fifteenMinutesAgo = new Date(NOW - 15 * 60_000).toISOString();
    expect(fifteenMinutesAgo > staleRunningCutoffIso(NOW)).toBe(true);
  });

  it("catches the real Sitges rows", () => {
    expect("2026-07-08T23:09:00.000Z" < staleRunningCutoffIso(NOW)).toBe(true);
    expect("2026-07-08T23:54:00.000Z" < staleRunningCutoffIso(NOW)).toBe(true);
  });
});

describe("reapStaleRunningJobs", () => {
  const sbWith = (result: unknown) => {
    const select = vi.fn().mockResolvedValue(result);
    const lt = vi.fn(() => ({ select }));
    const eq = vi.fn(() => ({ lt }));
    const update = vi.fn(() => ({ eq }));
    return { sb: { from: vi.fn(() => ({ update })) } as never, update, eq, lt, select };
  };

  it("fails only running rows older than the cutoff", async () => {
    const { sb, update, eq, lt } = sbWith({ data: [{ id: "a" }, { id: "b" }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the mock's
    // call tuple is typed as empty; the shape is asserted below.
    const n = await reapStaleRunningJobs(sb, NOW);
    expect(n).toBe(2);
    expect(eq).toHaveBeenCalledWith("status", "running");
    expect(lt).toHaveBeenCalledWith("started_at", staleRunningCutoffIso(NOW));
    const patch = (update.mock.calls as any[])[0][0] as { status: string; error: string; finished_at: string };
    expect(patch.status).toBe("failed");
    expect(patch.finished_at).toBe(new Date(NOW).toISOString());
    // The error has to explain itself — someone reading /jobs weeks later
    // needs to know this was reaped, not that the ingest genuinely failed.
    expect(patch.error).toMatch(/died without finishing/);
  });

  it("returns 0 when there is nothing to reap", async () => {
    const { sb } = sbWith({ data: [] });
    expect(await reapStaleRunningJobs(sb, NOW)).toBe(0);
  });

  it("never throws — housekeeping must not stop the sweep claiming real work", async () => {
    const sb = { from: () => { throw new Error("supabase down"); } } as never;
    await expect(reapStaleRunningJobs(sb, NOW)).resolves.toBe(0);
  });
});
