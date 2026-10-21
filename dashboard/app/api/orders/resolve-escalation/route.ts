import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId) return jsonError("orderId is required.", 400);

  const admin = createServiceClient();
  const { data: order } = await admin.from("orders").select("id, status").eq("id", body.orderId).single();
  if (!order) return jsonError("Order not found.", 404);
  if (order.status !== "escalated") return jsonError("Order is not currently escalated.", 409);

  // Race lock: only succeeds if the order is still escalated at write time. First writer wins,
  // a repeat call after resolution falls through to the 409 above rather than crashing.
  const { data: won } = await admin.from("orders").update({ status: "reaching_out" })
    .eq("id", body.orderId).eq("status", "escalated").select("id");
  if (!won || won.length === 0) return jsonError("Order is not currently escalated.", 409);

  await admin.from("order_events").insert({ order_id: body.orderId, type: "escalation_resolved", actor: gate.email });
  return Response.json({ ok: true, status: "reaching_out" });
}
