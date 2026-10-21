import { requireRole, jsonError } from "@/lib/apiAuth";
import { reconcileSweep, reconcileOrder, reconcileOrders, reconcileAll } from "@/lib/ingestWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only on-demand reconcile. Body {orderId} → reconcile that one order;
// {orderIds:[...]} → retry a specific batch (e.g. the ids a full sweep logged as
// failed to External ops); {all:"dry"|"apply"|"stop"} → arm/stop the full-table
// catch-up sweep, which aligns EVERY order with Shopify (the windowed sweeps
// only reach ~14d back); empty body → force the windowed sweep now (bypasses
// the hourly throttle). Delegates to the ingest worker (which owns the
// reconcile logic + the order queue); this route is just the authenticated,
// role-gated front door.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  const body = await req.json().catch(() => ({}));
  const orderId = typeof body?.orderId === "string" && body.orderId.trim() ? body.orderId.trim() : null;
  const orderIds = body?.orderIds;
  const all = body?.all;
  if (typeof all === "string") {
    if (all !== "dry" && all !== "apply" && all !== "stop") {
      return jsonError('all must be "dry", "apply" or "stop".', 400);
    }
    const armed = await reconcileAll(all);
    if (!armed.ok) return jsonError(armed.error, armed.status);
    return Response.json(armed.data);
  }

  if (orderIds !== undefined) {
    if (!Array.isArray(orderIds) || orderIds.length === 0 || !orderIds.every((id) => typeof id === "string" && id.trim())) {
      return jsonError("orderIds must be a non-empty array of non-empty strings.", 400);
    }
    const r = await reconcileOrders(orderIds.map((id: string) => id.trim()));
    if (!r.ok) return jsonError(r.error, r.status);
    return Response.json(r.data);
  }

  const r = orderId ? await reconcileOrder(orderId) : await reconcileSweep();
  if (!r.ok) return jsonError(r.error, r.status);
  return Response.json(r.data);
}
