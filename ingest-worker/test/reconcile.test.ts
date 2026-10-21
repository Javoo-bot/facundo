import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Supabase service client so reconcile.ts talks to a controllable stub.
const createServiceClient = vi.fn();
vi.mock("../src/db", () => ({ createServiceClient: () => createServiceClient() }));
vi.mock("../src/monitor", () => ({ captureError: vi.fn() }));

import { reconcileMissingOrders } from "../src/reconcile";
import type { Env } from "../src/types";

/** A chainable Supabase-query stub. `claimRows` is what the app_settings
 * claim-update resolves to (non-empty = won the throttle claim); `existingRows`
 * is what the orders SELECT ... IN(...) resolves to. `parkedRows` (optional)
 * backs selfHealParkedOrders' own `.eq("status","received")...limit()` query —
 * left undefined, that query throws (as it did before this option existed),
 * which reconcileMissingOrders swallows via its own .catch fallback, so every
 * pre-existing test above is unaffected. */
function makeSb(
  claimRows: unknown[],
  existingRows: { shopify_order_id: string }[],
  parkedRows?: Array<{ id: string; shopify_order_id: string; status: string; tags: string | null; order_assignments: { id: string }[] }>,
) {
  return {
    from(table: string) {
      if (table === "app_settings") {
        const chain: any = {
          update: () => chain,
          eq: () => chain,
          or: () => chain,
          select: async () => ({ data: claimRows, error: null }),
        };
        return chain;
      }
      // orders — three different query shapes land here (selfHeal's parked
      // select, backfillMissingTags' non-received select, and the bulk-pull's
      // existing-ids IN check). Distinguish by which status filter was applied.
      let statusFilter: "received" | "not-received" | null = null;
      const chain: any = {
        select: () => chain,
        eq: (col: string) => { if (col === "status") statusFilter = "received"; return chain; },
        neq: (col: string) => { if (col === "status") statusFilter = "not-received"; return chain; },
        gte: () => chain,
        in: async () => ({ data: existingRows, error: null }),
        limit: async () => {
          if (statusFilter === "received") {
            if (parkedRows === undefined) throw new Error("parked query not stubbed");
            return { data: parkedRows, error: null };
          }
          // backfillMissingTags' own query — not exercised by these tests, so an
          // empty result keeps it a same-tick no-op (see its rows.length===0 fast path).
          return { data: [], error: null };
        },
      };
      return chain;
    },
  };
}

function makeEnv(over: Partial<Env> = {}): { env: Env; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => {});
  const env = {
    SHOPIFY_SHOP: "shop.myshopify.com",
    SHOPIFY_ADMIN_TOKEN: "tok",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    ORDER_QUEUE: { send },
    ...over,
  } as unknown as Env;
  return { env, send };
}

function mockShopifyOrders(orders: { id: number | string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ orders }), text: async () => "" })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  createServiceClient.mockReset();
});

describe("reconcileMissingOrders", () => {
  it("is a no-op when Shopify creds are unset (never touches Supabase or fetch)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { env, send } = makeEnv({ SHOPIFY_SHOP: undefined });
    await reconcileMissingOrders(env);
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("bails without fetching when it lost the throttle claim (ran within the last hour)", async () => {
    createServiceClient.mockReturnValue(makeSb([], [])); // claim update returns 0 rows
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { env, send } = makeEnv();
    await reconcileMissingOrders(env);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("re-enqueues only orders missing from our table", async () => {
    createServiceClient.mockReturnValue(makeSb([{ id: 1 }], [{ shopify_order_id: "100" }]));
    mockShopifyOrders([{ id: 100 }, { id: 200 }, { id: 300 }]);
    const { env, send } = makeEnv();
    await reconcileMissingOrders(env);
    // 100 exists; 200 and 300 are missing → enqueued exactly as the webhook path.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({ shopifyOrderId: "200", raw: { id: 200 } });
    expect(send).toHaveBeenCalledWith({ shopifyOrderId: "300", raw: { id: 300 } });
  });

  it("enqueues nothing when every recent order is already present", async () => {
    createServiceClient.mockReturnValue(
      makeSb([{ id: 1 }], [{ shopify_order_id: "100" }, { shopify_order_id: "200" }]),
    );
    mockShopifyOrders([{ id: 100 }, { id: 200 }]);
    const { env, send } = makeEnv();
    await reconcileMissingOrders(env);
    expect(send).not.toHaveBeenCalled();
  });

  // Task 3: selfHealParkedOrders isn't exported, so its `capped` signal is only
  // observable through reconcileMissingOrders' parkedCapped field. All 100 rows
  // already carry an order_assignments row, so they're filtered out before any
  // Shopify call is made (needs.length === 0) — this pins the cap signal itself
  // without having to also stand up refreshFromShopify's full write path.
  it("surfaces parkedCapped:true when the parked query returns exactly SELFHEAL_CAP rows", async () => {
    const parkedRows = Array.from({ length: 100 }, (_, i) => ({
      id: `p${i}`, shopify_order_id: String(i), status: "received", tags: null,
      order_assignments: [{ id: `a${i}` }], // already has a candidate — filtered out of `needs`
    }));
    createServiceClient.mockReturnValue(makeSb([{ id: 1 }], [], parkedRows));
    mockShopifyOrders([]); // bulk pull: nothing to backfill
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await reconcileMissingOrders(makeEnv().env);

    expect(res.parkedChecked).toBe(0); // all 100 filtered out — none needed re-evaluating
    expect(res.parkedCapped).toBe(true);
    expect(res.tagsCapped).toBe(false); // backfillMissingTags saw an empty (unstubbed) window
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("selfHealParkedOrders"));
    warnSpy.mockRestore();
  });

  it("surfaces parkedCapped:false when the parked query returns fewer than SELFHEAL_CAP rows", async () => {
    const parkedRows = [
      { id: "p1", shopify_order_id: "1", status: "received", tags: null, order_assignments: [{ id: "a1" }] },
    ];
    createServiceClient.mockReturnValue(makeSb([{ id: 1 }], [], parkedRows));
    mockShopifyOrders([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await reconcileMissingOrders(makeEnv().env);

    expect(res.parkedCapped).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
