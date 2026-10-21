import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual staff override of a locked-in florist payout amount (e.g. a special-case
// negotiated price). Once overridden, `payout_percent` is cleared so the amount
// reads as "set by hand" rather than implying a percent-of-order basis that no
// longer holds — see lib/payoutMath.ts::computePayoutPrice for the normal path.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("finance", "admin");
  if (!gate.ok) return gate.res;

  let body: { assignmentId?: string; payoutPrice?: number };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.assignmentId) return jsonError("assignmentId is required.", 400);
  if (typeof body.payoutPrice !== "number" || !Number.isFinite(body.payoutPrice) || body.payoutPrice < 0) {
    return jsonError("payoutPrice must be a non-negative number.", 400);
  }

  const admin = createServiceClient();
  const { data: assignment } = await admin.from("order_assignments")
    .select("id, order_id, payout_price").eq("id", body.assignmentId).single();
  if (!assignment) return jsonError("Assignment not found.", 404);

  const payoutPrice = Math.round(body.payoutPrice * 100) / 100;
  const { error: updErr } = await admin.from("order_assignments")
    .update({ payout_price: payoutPrice, payout_percent: null })
    .eq("id", body.assignmentId);
  if (updErr) return jsonError("Could not update the payout amount.", 500);

  await admin.from("order_events").insert({
    order_id: assignment.order_id, type: "payout_overridden", actor: gate.email,
    payload: { assignment_id: body.assignmentId, previous_payout_price: assignment.payout_price, payout_price: payoutPrice },
  });

  return Response.json({ ok: true, payoutPrice });
}
