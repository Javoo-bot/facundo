import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/monitor", () => ({ captureError: vi.fn() }));

import { reconcileAllOrders, armFullSweep } from "../src/reconcile";
import type { Env } from "../src/types";

/**
 * The full-table catch-up sweep: walks EVERY order oldest-first in capped
 * batches on the per-minute cron, aligning each with Shopify via the same
 * refreshFromShopify primitive the webhook and the re-pull use.
 *
 * The two things most worth pinning here are the ones that fail silently:
 * (1) the keyset cursor must carry an id tiebreak, or a batch boundary landing
 *     inside a group of rows sharing a created_at skips the rest of that group
 *     — bulk imports write many rows in one transaction, so such groups are the
 *     norm, not an edge case; and
 * (2) dry mode must write NOTHING while still producing the same verdict as a
 *     real pass.
 */

interface Row { id: string; shopify_order_id: string; status: string; created_at: string }

/** `writeThrows` forces refreshFromShopify's own write to throw (simulating the
 *  ~line 447-448 catch site); `externalOpsThrows` forces the external_ops insert
 *  itself to fail, to prove a logging failure can never abort the sweep. */
function makeSb(
  rows: Row[],
  settings: Record<string, unknown> = {},
  opts: { writeThrows?: boolean; externalOpsThrows?: boolean } = {},
) {
  const settingsWrites: Record<string, unknown>[] = [];
  const orderWrites: { id: string; patch: Record<string, unknown> }[] = [];
  const externalOpsInserts: Record<string, unknown>[] = [];
  const filters: string[] = [];
  let served: Row[] = [];

  const sb: any = {
    from(table: string) {
      if (table === "external_ops") {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (opts.externalOpsThrows) throw new Error("external_ops insert failed");
            externalOpsInserts.push(row);
            return { error: null };
          },
        };
      }
      if (table === "app_settings") {
        const c: any = {
          select: () => c,
          eq: () => c,
          maybeSingle: async () => ({ data: { active_order_tags: [], ...settings }, error: null }),
          update: (patch: Record<string, unknown>) => { settingsWrites.push(patch); return { eq: async () => ({ error: null }) }; },
        };
        return c;
      }
      if (table === "order_assignments") {
        return { select: () => ({ eq: () => ({ in: async () => ({ count: 0, error: null }) }) }) };
      }
      if (table === "order_events") {
        return {
          insert: async () => ({ error: null }),
          select: () => ({ eq: () => ({ eq: async () => ({ count: 0, error: null }) }) }),
        };
      }
      if (table === "order_approvals") {
        return { update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) };
      }
      if (table === "order_line_items") {
        return {
          delete: () => ({ eq: async () => ({ error: null }) }),
          insert: async () => ({ error: null }),
          select: () => ({ eq: async () => ({ data: [], error: null }) }),
        };
      }
      // orders. NOTE: supabase-js's builder is THENABLE — .limit() returns the
      // builder, not a promise, which is why .or() can still be chained after
      // it. Modelling limit as async here would make the real code's
      // `q = q.or(...)` throw, so the stub has to be thenable too.
      const c: any = {
        select: () => c,
        is: () => c,
        // workingSetConfig's "are there any explicit picks?" head-count.
        // Resolves through the shared `then` below with no `count`, i.e. "no
        // picks" — which is what these tests assume.
        not: () => c,
        order: () => c,
        or: (f: string) => { filters.push(f); return c; },
        limit: (n: number) => { served = rows.slice(0, n); return c; },
        then: (resolve: (v: unknown) => void) => resolve({ data: served, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            if (opts.writeThrows) throw new Error("orders update failed");
            orderWrites.push({ id, patch });
            return { error: null };
          },
        }),
      };
      return c;
    },
  };
  return { sb, settingsWrites, orderWrites, externalOpsInserts, filters };
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    SHOPIFY_SHOP: "shop.myshopify.com", SHOPIFY_ADMIN_TOKEN: "tok",
    SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc", ...over,
  } as unknown as Env;
}

function mockShopify(order: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ order }), text: async () => "" })));
}

const fulfilled = { id: 1, tags: null, line_items: [], fulfillment_status: "fulfilled", closed_at: null, cancelled_at: null };
const open = { ...fulfilled, fulfillment_status: null };

afterEach(() => vi.unstubAllGlobals());

describe("reconcileAllOrders", () => {
  it("no-ops when nothing is armed", async () => {
    const { sb, settingsWrites } = makeSb([{ id: "a", shopify_order_id: "1", status: "received", created_at: "2026-08-01T00:00:00Z" }]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await reconcileAllOrders(makeEnv(), sb);

    expect(res.ran).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(settingsWrites).toEqual([]);
  });

  it("dry mode reports what would close and writes NOTHING to the order", async () => {
    const { sb, orderWrites, settingsWrites } = makeSb(
      [{ id: "a", shopify_order_id: "1", status: "escalated", created_at: "2026-08-01T00:00:00Z" }],
      { reconcile_all_mode: "dry" },
    );
    mockShopify(fulfilled);

    const res = await reconcileAllOrders(makeEnv(), sb);

    expect(res.stats).toMatchObject({ swept: 1, closed: 1, conflicts: 0, noChange: 0 });
    expect(orderWrites).toEqual([]); // the whole point of a dry run
    // Only the sweep's own cursor/stats are persisted.
    expect(settingsWrites).toHaveLength(1);
    expect(Object.keys(settingsWrites[0]).sort()).toEqual([
      "reconcile_all_after_created_at", "reconcile_all_after_id", "reconcile_all_mode", "reconcile_all_stats",
    ]);
  });

  it("dry mode counts an order Shopify still has open as no-change", async () => {
    const { sb } = makeSb(
      [{ id: "a", shopify_order_id: "1", status: "received", created_at: "2026-08-01T00:00:00Z" }],
      { reconcile_all_mode: "dry" },
    );
    mockShopify(open);

    const res = await reconcileAllOrders(makeEnv(), sb);

    expect(res.stats).toMatchObject({ swept: 1, closed: 0, noChange: 1 });
  });

  it("apply mode actually closes it", async () => {
    const { sb, orderWrites } = makeSb(
      [{ id: "a", shopify_order_id: "1", status: "escalated", created_at: "2026-08-01T00:00:00Z" }],
      { reconcile_all_mode: "apply" },
    );
    mockShopify(fulfilled);

    const res = await reconcileAllOrders(makeEnv(), sb);

    expect(res.stats).toMatchObject({ swept: 1, closed: 1 });
    expect(orderWrites.some((w) => w.patch.status === "closed")).toBe(true);
  });

  it("carries an id tiebreak in the cursor filter, not just the timestamp", async () => {
    // Without the tiebreak, a batch boundary inside a group of rows sharing a
    // created_at (every bulk import) silently skips the rest of that group.
    const { sb, filters } = makeSb(
      [{ id: "b", shopify_order_id: "2", status: "received", created_at: "2026-08-02T00:00:00Z" }],
      {
        reconcile_all_mode: "dry",
        reconcile_all_after_created_at: "2026-08-01T00:00:00+00:00",
        reconcile_all_after_id: "11111111-1111-1111-1111-111111111111",
      },
    );
    mockShopify(open);

    await reconcileAllOrders(makeEnv(), sb);

    expect(filters).toHaveLength(1);
    expect(filters[0]).toContain('created_at.gt."2026-08-01T00:00:00+00:00"');
    expect(filters[0]).toContain('and(created_at.eq."2026-08-01T00:00:00+00:00",id.gt.11111111-1111-1111-1111-111111111111)');
  });

  it("disarms itself once a short batch says the table is exhausted", async () => {
    const { sb, settingsWrites } = makeSb(
      [{ id: "a", shopify_order_id: "1", status: "received", created_at: "2026-08-01T00:00:00Z" }],
      { reconcile_all_mode: "apply" },
    );
    mockShopify(open);

    const res = await reconcileAllOrders(makeEnv(), sb);

    expect(res.done).toBe(true);
    expect(settingsWrites[0].reconcile_all_mode).toBeNull();
    expect((settingsWrites[0].reconcile_all_stats as { finishedAt?: string }).finishedAt).toBeTruthy();
  });

  it("counts a Shopify fetch failure as an error and keeps going", async () => {
    const { sb } = makeSb(
      [{ id: "a", shopify_order_id: "1", status: "received", created_at: "2026-08-01T00:00:00Z" }],
      { reconcile_all_mode: "dry" },
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })));

    const res = await reconcileAllOrders(makeEnv(), sb);

    expect(res.stats).toMatchObject({ swept: 0, errors: 1 });
  });

  it("no-ops without touching Shopify when creds are unset", async () => {
    const { sb } = makeSb([{ id: "a", shopify_order_id: "1", status: "received", created_at: "2026-08-01T00:00:00Z" }], { reconcile_all_mode: "apply" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await reconcileAllOrders(makeEnv({ SHOPIFY_SHOP: undefined }), sb);

    expect(res.ran).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Task 1: durable, actionable failure records. Both catch sites must leave a
  // row in external_ops (the only place a failed order id survives — captureError
  // only reaches the ephemeral Cloudflare tail log), and a Supabase problem while
  // WRITING that row must never take the sweep down with it.
  it("logs a Shopify fetch failure to external_ops with the row shape", async () => {
    const { sb, externalOpsInserts } = makeSb(
      [{ id: "a", shopify_order_id: "1", status: "received", created_at: "2026-08-01T00:00:00Z" }],
      { reconcile_all_mode: "dry" },
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })));

    const res = await reconcileAllOrders(makeEnv(), sb);

    expect(res.stats).toMatchObject({ swept: 0, errors: 1 });
    expect(externalOpsInserts).toHaveLength(1);
    expect(externalOpsInserts[0]).toMatchObject({
      provider: "shopify", operation: "reconcile_all", direction: "out",
      order_id: "a", ref: "1", ok: false, error: expect.any(String),
      meta: { cause: "fetch" },
    });
  });

  it("logs a refreshFromShopify write failure to external_ops with the row shape", async () => {
    const { sb, externalOpsInserts } = makeSb(
      [{ id: "a", shopify_order_id: "1", status: "escalated", created_at: "2026-08-01T00:00:00Z" }],
      { reconcile_all_mode: "apply" },
      { writeThrows: true },
    );
    mockShopify(fulfilled);

    const res = await reconcileAllOrders(makeEnv(), sb);

    expect(res.stats).toMatchObject({ swept: 1, errors: 1 });
    expect(externalOpsInserts).toHaveLength(1);
    expect(externalOpsInserts[0]).toMatchObject({
      provider: "shopify", operation: "reconcile_all", direction: "out",
      order_id: "a", ref: "1", ok: false, error: expect.any(String),
      meta: { cause: "write" },
    });
  });

  it("a failing external_ops insert does not abort the sweep or change stats.errors behavior", async () => {
    const { sb, externalOpsInserts } = makeSb(
      [{ id: "a", shopify_order_id: "1", status: "received", created_at: "2026-08-01T00:00:00Z" }],
      { reconcile_all_mode: "dry" },
      { externalOpsThrows: true },
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })));

    // Must not throw out of reconcileAllOrders even though the logging write fails.
    const res = await reconcileAllOrders(makeEnv(), sb);

    // Identical to the plain fetch-failure case above: stats.errors still moves
    // exactly once, the sweep still finishes and reports its stats.
    expect(res.stats).toMatchObject({ swept: 0, errors: 1 });
    expect(externalOpsInserts).toEqual([]); // the insert itself failed, so nothing landed
  });
});

describe("armFullSweep", () => {
  it("resets the cursor and stats so an arming always starts from the beginning", async () => {
    const { sb, settingsWrites } = makeSb([], {
      reconcile_all_after_created_at: "2026-08-01T00:00:00Z",
      reconcile_all_after_id: "old",
    });

    await armFullSweep(makeEnv(), "apply", sb);

    expect(settingsWrites[0]).toMatchObject({
      reconcile_all_mode: "apply",
      reconcile_all_after_created_at: null,
      reconcile_all_after_id: null,
    });
  });

  it("stopping clears the mode and the stats", async () => {
    const { sb, settingsWrites } = makeSb([], { reconcile_all_mode: "apply" });

    await armFullSweep(makeEnv(), null, sb);

    expect(settingsWrites[0]).toMatchObject({ reconcile_all_mode: null, reconcile_all_stats: null });
  });
});
