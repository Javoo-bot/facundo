import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isOrderStatus, type OrderStatus } from "@/lib/orderStatus";
import { writeOrderStatus } from "@/lib/orderStatusWrite";
import { hasUnresolvedConflict, CONFLICT_EVENT, CONFLICT_RESOLVED_EVENT } from "@/lib/shopifyConflict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Accept Shopify's truth" — the staff resolution for an unresolved
// `shopify_conflict` (see ingest-worker/src/shopifyLifecycle.ts::orderClosure
// and lib/shopifyConflict.ts). Forces the order straight to `closed`,
// bypassing the normal `canStaffSet` stepper (lib/orderStages.ts) — that
// machine deliberately does NOT allow e.g. accepted → closed in one hop, but
// this is a one-time recovery action, not a general stage move. Reuses the
// SAME write primitive as POST /api/orders/status (lib/orderStatusWrite.ts)
// rather than a parallel status path.
//
// Does NOT touch order_assignments and does NOT itself call into payout.ts —
// see lib/shopifyConflict.ts::describeConflictCloseImpact for exactly what
// that leaves open, which the order page's confirm step surfaces before this
// route is ever called.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId) return jsonError("orderId is required.", 400);

  const admin = createServiceClient();
  const [{ data: order }, { data: events }] = await Promise.all([
    admin.from("orders").select("status").eq("id", body.orderId).single(),
    admin.from("order_events").select("type").eq("order_id", body.orderId).in("type", [CONFLICT_EVENT, CONFLICT_RESOLVED_EVENT]),
  ]);
  if (!order || !isOrderStatus(order.status)) return jsonError("Order not found.", 404);
  const from = order.status as OrderStatus;
  if (from === "closed" || from === "cancelled") return jsonError(`Order is already ${from}.`, 409);
  if (!hasUnresolvedConflict(events ?? [])) return jsonError("No unresolved Shopify conflict on this order.", 409);

  const won = await writeOrderStatus(admin, {
    orderId: body.orderId, from, to: "closed", actor: gate.email,
    eventPayload: { reason: "shopify_conflict" },
  });
  if (!won) return jsonError("Order changed — refresh and retry.", 409);

  // The resolution marker — the SAME event type the "keep ours" dismiss route
  // writes, so cxAttention.ts only needs one check regardless of outcome.
  await admin.from("order_events").insert({
    order_id: body.orderId,
    type: CONFLICT_RESOLVED_EVENT,
    actor: gate.email,
    payload: { resolution: "accepted_shopify_truth", from },
  });

  return Response.json({ ok: true, status: "closed" });
}
