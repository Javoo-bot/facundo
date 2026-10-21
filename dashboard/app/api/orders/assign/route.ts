import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { computePayoutPrice } from "@/lib/payoutMath";
import { manualAssignAudience } from "@/lib/coldOffer";
import { captureError } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manually attach a SPECIFIC florist to an order — the staff override that
// bypasses matching's onboarded hard filter. Adds the florist as a candidate
// (or `queued`, ready to send, when `offer` is set). Actually emailing the offer
// stays a deliberate, test-mode-gated Send in the reach-out panel — this route
// never sends on its own (mirrors reassign, so no message goes out silently).
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string; floristId?: string; offer?: boolean };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId || !body.floristId) return jsonError("orderId and floristId are required.", 400);

  const admin = createServiceClient();
  const [{ data: order }, { data: florist }, { data: settings }] = await Promise.all([
    admin.from("orders").select("id, status, delivery_at, total").eq("id", body.orderId).single(),
    admin.from("florists").select("id, name, source, lifecycle_stage, joined_at, excluded_at, deleted_at").eq("id", body.floristId).single(),
    admin.from("app_settings").select("default_payout_percent").eq("id", 1).single(),
  ]);
  if (!order) return jsonError("Order not found.", 404);
  if (!florist) return jsonError("Florist not found.", 404);

  // Lock in the florist's payout price (and the percent used) at match time — see
  // dashboard Settings → Payments. Mirrors the automatic-match candidates so a
  // manually-added florist sees the same payout as one matched automatically.
  // Basis is the order's actual (post-discount) total — see computePayoutPrice.
  const payoutPercent = settings?.default_payout_percent ?? 55;
  const payoutPrice = computePayoutPrice(order.total ?? 0, payoutPercent);
  // The manual override bypasses the *onboarded* filter by design — but NOT the
  // denylist, and NOT a soft-deleted florist (a row cleaned up by re-ingest/the
  // relevance filter no longer represents a real, contactable business).
  if (florist.excluded_at) return jsonError("That florist is excluded (denylisted) and can't be added.", 409);
  if (florist.deleted_at) return jsonError("That florist has been removed and can't be added.", 409);

  const { data: existing } = await admin.from("order_assignments")
    .select("id, florist_id, rank").eq("order_id", body.orderId);
  if ((existing ?? []).some((a) => a.florist_id === body.floristId)) {
    return jsonError("That florist is already on this order.", 409);
  }
  const maxRank = (existing ?? []).reduce((m, a) => Math.max(m, a.rank ?? 0), 0);
  const onboarded = florist.lifecycle_stage === "production" || florist.lifecycle_stage === "onboarding";
  const slaDeadline = order.delivery_at
    ? new Date(new Date(order.delivery_at).getTime() - 2 * 3600 * 1000).toISOString()
    : null;

  const { data: inserted, error: insErr } = await admin.from("order_assignments").insert({
    order_id: body.orderId,
    florist_id: body.floristId,
    rank: maxRank + 1,
    florist_source: florist.source,
    status: body.offer ? "queued" : "candidate",
    offer_kind: "race",
    sla_deadline_at: slaDeadline,
    payout_price: payoutPrice,
    payout_percent: payoutPercent,
  }).select("id").single();
  if (insErr || !inserted) return jsonError("Could not add the florist.", 500);

  // A shop that never joined gets the cold-offer activation when it accepts
  // (the owner, 2026-10-14). A separate write so a database without the `manual`
  // value yet still adds the florist; it just won't activate on accept.
  const audience = manualAssignAudience(florist);
  if (audience === "manual") {
    const { error: stampErr } = await admin.from("order_assignments")
      .update({ offer_audience: audience }).eq("id", inserted.id);
    if (stampErr) captureError("orders.assign.stampManualAudience", stampErr);
  }

  // A bare 'received'/'matched' order now has a manual candidate — reflect that.
  if (order.status === "received") {
    await admin.from("orders").update({ status: "matched" }).eq("id", body.orderId).eq("status", "received");
  }
  await admin.from("order_events").insert({
    order_id: body.orderId, type: "florist_added", actor: gate.email,
    payload: { florist_id: body.floristId, florist_name: florist.name, onboarded, queued: !!body.offer },
  });

  return Response.json({ ok: true, assignmentId: inserted.id, onboarded });
}
