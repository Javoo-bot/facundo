import { afterEach, describe, expect, it, vi } from "vitest";

// Task 2: reconcileOrders is the admin-driven batch retry for orders a full
// sweep logged as failed (see reconcileAll.test.ts's external_ops tests). It
// deliberately does no discovery of its own — it just loops reconcileOneOrder,
// which this test proves by giving each order a distinct Shopify outcome and
// checking they're reflected independently, in order, in the batch result.
//
// Unlike reconcile.test.ts (which mocks "../src/db" wholesale, safe there
// because those tests never let refreshFromShopify actually run), this needs
// refreshFromShopify's real write path — appendOrderEvent, replaceLineItems,
// setOrderStatus all live in db.ts and are imported directly by lateMatch.ts.
// So only createServiceClient is overridden; everything else in db.ts stays
// real and runs against the stub below.
const createServiceClient = vi.fn();
vi.mock("../src/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db")>();
  return { ...actual, createServiceClient: () => createServiceClient() };
});
vi.mock("../src/monitor", () => ({ captureError: vi.fn() }));

import { reconcileOrders } from "../src/reconcile";
import type { Env } from "../src/types";

interface StoredOrder {
  shopify_order_id: string;
  status: string;
  tags: string | null;
  city_id: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_at: string | null;
  shipping_total: number | null;
}

/** Chainable stub covering exactly what reconcileOneOrder + refreshFromShopify
 * touch: an "orders" table serving both the by-id lookup (select().eq("id",
 * ...).maybeSingle()) and the Shopify-owned-columns writeback (update().eq()),
 * plus the handful of other tables refreshFromShopify's real db.ts helpers
 * write to (order_line_items, order_events, order_approvals, order_assignments)
 * — the same minimal set reconcileAll.test.ts already proved sufficient for a
 * "close" outcome. */
function makeSb(ordersById: Record<string, StoredOrder>) {
  const writes: { id: string; patch: Record<string, unknown> }[] = [];
  const sb: any = {
    from(table: string) {
      if (table === "orders") {
        let lookupId: string | null = null;
        const c: any = {
          select: () => c,
          eq: (_col: string, v: string) => { lookupId = v; return c; },
          // workingSetConfig's "are there any explicit picks?" head-count:
          // .select("id", {count, head}).not("worklist_at", …).is("deleted_at", …)
          not: () => c,
          is: () => c,
          then: (res: (v: { count: number; error: null }) => unknown) => res({ count: 0, error: null }),
          maybeSingle: async () => {
            const row = lookupId ? ordersById[lookupId] : undefined;
            return { data: row ? { id: lookupId, ...row } : null, error: null };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: async (_c: string, id: string) => { writes.push({ id, patch }); return { error: null }; },
          }),
        };
        return c;
      }
      if (table === "app_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { active_order_tags: [] }, error: null }) }) }) };
      }
      if (table === "order_assignments") {
        return { select: () => ({ eq: () => ({ in: async () => ({ count: 0, error: null }) }) }) };
      }
      if (table === "order_events") {
        return { insert: async () => ({ error: null }), select: () => ({ eq: () => ({ eq: async () => ({ count: 0, error: null }) }) }) };
      }
      if (table === "order_approvals") {
        return { update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) };
      }
      if (table === "order_line_items") {
        return { delete: () => ({ eq: async () => ({ error: null }) }), insert: async () => ({ error: null }), select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      return {};
    },
  };
  return { sb, writes };
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    SHOPIFY_SHOP: "shop.myshopify.com", SHOPIFY_ADMIN_TOKEN: "tok",
    SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc", ...over,
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  createServiceClient.mockReset();
});

describe("reconcileOrders", () => {
  it("retries each id independently and returns per-order results in order", async () => {
    const ordersById: Record<string, StoredOrder> = {
      o1: { shopify_order_id: "111", status: "escalated", tags: null, city_id: null, delivery_lat: null, delivery_lng: null, delivery_at: null, shipping_total: null },
      o2: { shopify_order_id: "222", status: "escalated", tags: null, city_id: null, delivery_lat: null, delivery_lng: null, delivery_at: null, shipping_total: null },
    };
    const { sb, writes } = makeSb(ordersById);
    createServiceClient.mockReturnValue(sb);
    vi.stubGlobal("fetch", vi.fn(async (url: string): Promise<{ ok: boolean; status?: number; json: () => Promise<unknown>; text: () => Promise<string> }> => {
      // o1's Shopify order is fulfilled → refreshFromShopify should close it.
      if (url.includes("/orders/111.json")) {
        return { ok: true, json: async () => ({ order: { id: 111, tags: null, line_items: [], fulfillment_status: "fulfilled", closed_at: null, cancelled_at: null } }), text: async () => "" };
      }
      // o2's Shopify order is still open and its tags haven't changed → noop.
      if (url.includes("/orders/222.json")) {
        return { ok: true, json: async () => ({ order: { id: 222, tags: null, line_items: [], fulfillment_status: null, closed_at: null, cancelled_at: null } }), text: async () => "" };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    }));

    const results = await reconcileOrders(makeEnv(), ["o1", "o2", "missing"]);

    expect(results).toEqual([
      { orderId: "o1", result: { found: true, result: "closed", tags: null } },
      { orderId: "o2", result: { found: true, result: "noop", tags: null } },
      { orderId: "missing", result: { found: false, reason: "not-found" } },
    ]);
    // o1 actually got its status flipped to closed; o2 (open, no tag change) wrote
    // the Shopify-owned columns but never touched status.
    expect(writes.some((w) => w.id === "o1" && w.patch.status === "closed")).toBe(true);
    expect(writes.some((w) => w.id === "o2" && "status" in w.patch)).toBe(false);
  });

  it("returns an empty array for an empty id list without calling Shopify", async () => {
    const { sb } = makeSb({});
    createServiceClient.mockReturnValue(sb);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const results = await reconcileOrders(makeEnv(), []);

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a per-order no-op (not a whole-batch failure) when Shopify creds are unset", async () => {
    const { sb } = makeSb({ o1: { shopify_order_id: "111", status: "escalated", tags: null, city_id: null, delivery_lat: null, delivery_lng: null, delivery_at: null, shipping_total: null } });
    createServiceClient.mockReturnValue(sb);

    const results = await reconcileOrders(makeEnv({ SHOPIFY_SHOP: undefined }), ["o1"]);

    expect(results).toEqual([{ orderId: "o1", result: { found: false, reason: "shopify-creds-unset" } }]);
  });
});
