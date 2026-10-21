import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { releaseWithoutPhoto } from "@/lib/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff override for the "delivered but no proof photo" case: CX has confirmed
// delivery out-of-band (call / customer reply) and releases the 30% by hand. A
// reason is mandatory (recorded on the payout + order timeline). Marks the order
// delivered (no photo did it) and force-issues / releases the delivery leg.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("finance", "admin");
  if (!gate.ok) return gate.res;

  let body: { assignmentId?: string; reason?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const assignmentId = body.assignmentId;
  const reason = (body.reason ?? "").trim();
  if (!assignmentId) return jsonError("assignmentId is required.", 400);
  if (!reason) return jsonError("A reason is required to release without a photo.", 400);

  const admin = createServiceClient();
  const { data: a } = await admin.from("order_assignments").select("id, order_id, status").eq("id", assignmentId).single();
  if (!a) return jsonError("Assignment not found.", 404);
  if (a.status !== "accepted" && a.status !== "delivered") return jsonError("Order isn't in a deliverable state.", 409);

  // Mark delivered (CAS from accepted/delivered) — no proof photo triggered it.
  await admin.from("order_assignments").update({ status: "delivered" }).eq("id", assignmentId).in("status", ["accepted", "delivered"]);
  await admin.from("orders").update({ status: "delivered" }).eq("id", a.order_id).in("status", ["accepted", "in_production", "ready", "out_for_delivery", "delivered"]);

  const r = await releaseWithoutPhoto(assignmentId, gate.email, reason);
  if (r.added) return Response.json({ ok: true, amount: r.amount, currency: r.currency });
  if (r.reason?.startsWith("already-")) {
    return Response.json({ ok: false, reason: r.reason, error: `Delivery payout is already ${r.reason.replace("already-", "")}.` }, { status: 409 });
  }
  const msg = r.reason === "paused" ? "Payments are paused (kill switch on)."
    : r.reason === "exposure_capped" ? "Blocked — florist exposure cap reached."
    : r.reason === "insufficient_funds" ? "Blocked — insufficient Airwallex funds."
    : r.detail ? `Couldn't release the payout — ${r.detail}`
    : "Couldn't release the payout.";
  return Response.json({ ok: false, reason: r.reason, error: msg }, { status: 409 });
}
