import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/monitor", () => ({ captureError: vi.fn() }));

import { backfillMissingTags } from "../src/reconcile";
import type { Env } from "../src/types";

/**
 * Regression cover for the gap that left 133 orders with `tags = NULL` forever:
 * the self-heal sweep selected `.eq("status", "received")`, so an order that had
 * already left "received" (escalated, cancelled, worked) could never have its
 * tags refreshed. The store app tags orders minutes AFTER checkout, so any order
 * whose orders/updated webhook was missed — a deploy gap, a dropped delivery —
 * kept NULL tags permanently and stayed invisible to the active-tag filter.
 *
 * The sweep now pulls the FULL Shopify order rather than `?fields=id,tags` and
 * refreshes everything Shopify owns (see refreshFromShopify), so these tests also
 * pin the wider write and the fulfilled/archived closure that rides with it.
 */

interface Row {
  id: string;
  shopify_order_id: string;
  status: string;
  tags: string | null;
}

/** Chainable Supabase stub. Records the filters the SELECT applied so the test
 * can assert the sweep is not scoped to a single status, and captures writes. */
function makeSb(rows: Row[], opts: { inFlight?: boolean } = {}) {
  const filters: Record<string, unknown> = {};
  const updates: { id: string; tags: string | null; patch: Record<string, unknown> }[] = [];
  const events: { order_id: string; type: string }[] = [];
  const statuses: { id: string; status: string }[] = [];
  const approvalsResolved: string[] = [];

  const sb: any = {
    from(table: string) {
      if (table === "app_settings") {
        const c: any = {
          select: () => c,
          eq: () => c,
          maybeSingle: async () => ({ data: { active_order_tags: [] }, error: null }),
        };
        return c;
      }
      if (table === "order_events") {
        return {
          insert: async (row: { order_id: string; type: string }) => { events.push(row); return { error: null }; },
          select: () => ({ eq: () => ({ eq: async () => ({ count: 0, error: null }) }) }),
        };
      }
      if (table === "order_line_items") {
        return {
          delete: () => ({ eq: async () => ({ error: null }) }),
          insert: async () => ({ error: null }),
          select: () => ({ eq: async () => ({ data: [], error: null }) }),
        };
      }
      if (table === "order_assignments") {
        // hasFloristInFlight: select(..., {head, count}).eq().in()
        return { select: () => ({ eq: () => ({ in: async () => ({ count: opts.inFlight ? 1 : 0, error: null }) }) }) };
      }
      if (table === "order_approvals") {
        return {
          update: () => ({
            eq: (_c: string, orderId: string) => ({
              eq: async () => { approvalsResolved.push(orderId); return { error: null }; },
            }),
          }),
        };
      }
      // orders
      const c: any = {
        select: () => c,
        is: (col: string, v: unknown) => { filters[`is:${col}`] = v; return c; },
        eq: (col: string, v: unknown) => { filters[`eq:${col}`] = v; return c; },
        neq: (col: string, v: unknown) => { filters[`neq:${col}`] = v; return c; },
        gte: (col: string, v: unknown) => { filters[`gte:${col}`] = v; return c; },
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            // setOrderStatus sends {status} alone; the Shopify-owned refresh sends the wide patch.
            if (Object.keys(patch).length === 1 && "status" in patch) statuses.push({ id, status: patch.status as string });
            else updates.push({ id, tags: (patch.tags ?? null) as string | null, patch });
            return { error: null };
          },
        }),
        limit: async () => ({ data: rows, error: null }),
        // workingSetConfig's "are there any explicit picks?" head-count:
        // .select("id", {count, head}).not("worklist_at", …).is("deleted_at", …).
        // It never calls .limit(), so it resolves through this thenable instead.
        not: (col: string, _op: string, v: unknown) => { filters[`not:${col}`] = v; return c; },
        then: (resolve: (v: { count: number; error: null }) => unknown) => resolve({ count: 0, error: null }),
      };
      return c;
    },
  };
  return { sb, filters, updates, events, statuses, approvalsResolved };
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    SHOPIFY_SHOP: "shop.myshopify.com",
    SHOPIFY_ADMIN_TOKEN: "tok",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    ...over,
  } as unknown as Env;
}

/** A full Shopify order, as the widened fetch now returns it. */
function shopifyOrder(over: Record<string, unknown> = {}) {
  return {
    id: 1, name: "#1", created_at: "2026-08-01T10:00:00Z", currency: "EUR",
    total_price: "50.00", financial_status: "paid", fulfillment_status: null,
    closed_at: null, cancelled_at: null, tags: null, line_items: [], ...over,
  };
}

function mockShopify(order: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ order }), text: async () => "" })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("backfillMissingTags", () => {
  it("backfills an ESCALATED order whose tags never arrived (the 133-order bug)", async () => {
    const { sb, updates } = makeSb([
      { id: "o1", shopify_order_id: "7797869805896", status: "escalated", tags: null },
    ]);
    mockShopify(shopifyOrder({ tags: "28 July 2026, local-florist, new-customer" }));

    const res = await backfillMissingTags(makeEnv(), sb);

    expect(updates.map((u) => ({ id: u.id, tags: u.tags }))).toEqual([
      { id: "o1", tags: "28 July 2026, local-florist, new-customer" },
    ]);
    expect(res.updated).toEqual(["o1"]);
  });

  it("selects on status only, NOT on tags being null — the root cause of the second gap", async () => {
    const { sb, filters } = makeSb([]);
    mockShopify(shopifyOrder());
    await backfillMissingTags(makeEnv(), sb);

    // Must NOT be scoped to tags IS NULL — an order that already picked up a
    // stale (non-null) tag before leaving "received" needs re-checking too.
    expect(filters["is:tags"]).toBeUndefined();
    // ...and must NOT be pinned to status = 'received' (what the old sweep did).
    expect(filters["eq:status"]).toBeUndefined();
  });

  it("refreshes a MATCHED order's STALE (non-null) tags, not just missing ones", async () => {
    const { sb, updates } = makeSb([
      { id: "o7", shopify_order_id: "555", status: "matched", tags: "28 July 2026, new-customer" },
    ]);
    // Shopify's live tags now include local-florist too — our stored copy is stale.
    mockShopify(shopifyOrder({ tags: "28 July 2026, new-customer, local-florist" }));

    const res = await backfillMissingTags(makeEnv(), sb);

    expect(updates.map((u) => ({ id: u.id, tags: u.tags }))).toEqual([
      { id: "o7", tags: "28 July 2026, new-customer, local-florist" },
    ]);
    expect(res.updated).toEqual(["o7"]);
  });

  it("refreshes Shopify-owned columns even when Shopify still has no tags, but reports no change", async () => {
    // Shopify is the truth: the sweep now writes what it says (here, still no
    // tags) rather than skipping the row. Nothing user-visible changed, so the
    // order is not counted as updated.
    const { sb, updates } = makeSb([
      { id: "o2", shopify_order_id: "999", status: "escalated", tags: null },
    ]);
    mockShopify(shopifyOrder({ financial_status: "refunded" }));

    const res = await backfillMissingTags(makeEnv(), sb);

    expect(updates).toHaveLength(1);
    expect(updates[0].tags).toBeNull();
    expect(updates[0].patch.financial_status).toBe("refunded");
    expect(res.updated).toEqual([]);
  });

  it("closes an order Shopify has fulfilled, and clears its pending approval", async () => {
    const { sb, statuses, events, approvalsResolved } = makeSb([
      { id: "o4", shopify_order_id: "5", status: "escalated", tags: null },
    ]);
    mockShopify(shopifyOrder({ fulfillment_status: "fulfilled", tags: "local-florist" }));

    const res = await backfillMissingTags(makeEnv(), sb);

    expect(statuses).toEqual([{ id: "o4", status: "closed" }]);
    expect(approvalsResolved).toEqual(["o4"]);
    expect(events.map((e) => e.type)).toContain("shopify_closed");
    expect(res.updated).toEqual(["o4"]);
  });

  it("archived alone closes it too — Shopify's archive is closed_at", async () => {
    const { sb, statuses } = makeSb([
      { id: "o5", shopify_order_id: "6", status: "received", tags: null },
    ]);
    mockShopify(shopifyOrder({ closed_at: "2026-08-03T15:00:00Z" }));

    await backfillMissingTags(makeEnv(), sb);

    expect(statuses).toEqual([{ id: "o5", status: "closed" }]);
  });

  it("flags a conflict instead of closing over a florist mid-delivery", async () => {
    const { sb, statuses, events } = makeSb(
      [{ id: "o6", shopify_order_id: "7", status: "accepted", tags: null }],
      { inFlight: true },
    );
    mockShopify(shopifyOrder({ fulfillment_status: "fulfilled" }));

    await backfillMissingTags(makeEnv(), sb);

    expect(statuses).toEqual([]); // status untouched — a human settles the payout
    expect(events.map((e) => e.type)).toContain("shopify_conflict");
  });

  it("no-ops without touching Shopify when creds are unset", async () => {
    const { sb } = makeSb([{ id: "o3", shopify_order_id: "1", status: "escalated", tags: null }]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await backfillMissingTags(makeEnv({ SHOPIFY_SHOP: undefined }), sb);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.checked).toBe(0);
  });

  it("keeps going when one order's Shopify fetch fails", async () => {
    const { sb, updates } = makeSb([
      { id: "bad", shopify_order_id: "1", status: "escalated", tags: null },
      { id: "good", shopify_order_id: "2", status: "cancelled", tags: null },
    ]);
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}), text: async () => "" } as any;
      return { ok: true, json: async () => ({ order: shopifyOrder({ id: 2, tags: "local-florist" }) }), text: async () => "" } as any;
    }));

    const res = await backfillMissingTags(makeEnv(), sb);

    expect(updates.map((u) => ({ id: u.id, tags: u.tags }))).toEqual([{ id: "good", tags: "local-florist" }]);
    expect(res.updated).toEqual(["good"]);
  });

  // Task 3: a capped pass looks identical to a genuinely-exhausted one unless it
  // says so. TAG_BACKFILL_CAP is 100 (see reconcile.ts) — every Shopify fetch is
  // made to fail here so the test only has to prove the cap signal + its log
  // line, not re-prove the per-row write behavior already covered above.
  it("reports capped:true and warns when the query returns exactly TAG_BACKFILL_CAP rows", async () => {
    const rows: Row[] = Array.from({ length: 100 }, (_, i) => ({
      id: `o${i}`, shopify_order_id: String(i), status: "escalated", tags: null,
    }));
    const { sb } = makeSb(rows);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })));

    const res = await backfillMissingTags(makeEnv(), sb);

    expect(res.checked).toBe(100);
    expect(res.capped).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("backfillMissingTags"));
    warnSpy.mockRestore();
  });

  it("reports capped:false when the query returns fewer than TAG_BACKFILL_CAP rows", async () => {
    const rows: Row[] = [{ id: "o1", shopify_order_id: "1", status: "escalated", tags: null }];
    const { sb } = makeSb(rows);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })));

    const res = await backfillMissingTags(makeEnv(), sb);

    expect(res.capped).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
