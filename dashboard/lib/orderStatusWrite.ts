import type { OrderStatus } from "./orderStatus";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase admin client is loosely typed
type Admin = any;

/**
 * The core status write shared by every staff-driven order-status transition:
 * compare-and-set (only the writer that still sees `from` wins) + the
 * `status:<to>` order_events row. Extracted out of POST /api/orders/status so
 * the Shopify-conflict "accept Shopify's truth" resolution
 * (app/api/orders/shopify-conflict/close/route.ts) — which jumps straight from
 * whatever live status the order is at to `closed`, a move `canStaffSet`
 * deliberately does NOT allow the general stepper to make (see
 * lib/orderStages.ts) — reuses the exact same write instead of a parallel one.
 * Callers still own their own eligibility checks and any status-specific side
 * effects (clawback on cancel, the "on the way" email, …) — this only does the
 * write + event.
 */
export async function writeOrderStatus(
  admin: Admin,
  o: { orderId: string; from: OrderStatus; to: OrderStatus; actor: string; eventPayload?: Record<string, unknown> }
): Promise<boolean> {
  const { data: won } = await admin
    .from("orders")
    .update({ status: o.to })
    .eq("id", o.orderId)
    .eq("status", o.from)
    .select("id");
  if (!won || won.length === 0) return false;

  await admin.from("order_events").insert({
    order_id: o.orderId,
    type: `status:${o.to}`,
    payload: { via: "staff", from: o.from, ...(o.eventPayload ?? {}) },
    actor: o.actor,
  });
  return true;
}
