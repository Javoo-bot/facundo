import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { hasUnresolvedConflict, CONFLICT_EVENT, CONFLICT_RESOLVED_EVENT } from "@/lib/shopifyConflict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Keep ours" — CX has decided our side is right (or is handling it another
// way outside the workflow) and just wants the conflict to stop nagging the
// attention queue.
// Writes the same `shopify_conflict_resolved` marker as the close route (see
// lib/shopifyConflict.ts) but touches NOTHING else — no status change, no
// payout action.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId) return jsonError("orderId is required.", 400);

  const admin = createServiceClient();
  const { data: order } = await admin.from("orders").select("id").eq("id", body.orderId).single();
  if (!order) return jsonError("Order not found.", 404);

  const { data: events } = await admin
    .from("order_events")
    .select("type")
    .eq("order_id", body.orderId)
    .in("type", [CONFLICT_EVENT, CONFLICT_RESOLVED_EVENT]);
  if (!hasUnresolvedConflict(events ?? [])) return jsonError("No unresolved Shopify conflict on this order.", 409);

  await admin.from("order_events").insert({
    order_id: body.orderId,
    type: CONFLICT_RESOLVED_EVENT,
    actor: gate.email,
    payload: { resolution: "kept_ours" },
  });

  return Response.json({ ok: true });
}
