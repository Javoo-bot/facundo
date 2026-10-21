import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { clawbackForOrder } from "@/lib/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Florist-initiated "give this order back": the florist who currently holds an
// accepted, not-yet-delivered order can hand it back (can't fulfil / going
// dark / etc). Mirrors /api/florist/respond's ownership + CAS style. Money
// unwind reuses the same clawbackForOrder the staff cancel flow calls — never
// touches payout.ts's hold/release/issue logic directly. On success the order
// demotes to `reaching_out` so the wave engine (advanceWaves) re-offers the
// next candidate on its next tick.
export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);

  let b: { assignmentId?: string; reason?: string; detail?: string };
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!b.assignmentId) return jsonError("assignmentId required.", 400);

  const admin = createServiceClient();
  // OWNERSHIP: the assignment must belong to THIS florist.
  const { data: a } = await admin.from("order_assignments").select("id, order_id, florist_id, status").eq("id", b.assignmentId).single();
  if (!a || a.florist_id !== me.floristId) return jsonError("Not your order.", 403);
  if (a.status !== "accepted") return jsonError("This order isn't currently yours to give back.", 409);

  // RACE LOCK: CAS accepted → released. Only the caller that still sees
  // 'accepted' wins — a concurrent staff reassign/cancel or a delivered-photo
  // upload racing in can't be clobbered.
  const { data: released } = await admin.from("order_assignments")
    .update({ status: "released", decline_reason: b.reason ?? null, decline_detail: b.detail ?? null })
    .eq("id", a.id).eq("status", "accepted").select("id");
  if (!released || released.length === 0) return jsonError("This order already changed — refresh and try again.", 409);

  // Void/claw back any accept-leg payout already issued for this order.
  // Best-effort by design (clawbackForOrder swallows + pages its own
  // failures) — must never block the give-back itself, same contract the
  // staff cancel flow relies on.
  await clawbackForOrder(a.order_id, null).catch((e) => {
    console.error("clawbackForOrder", e);
  });

  await admin.from("order_events").insert({
    order_id: a.order_id,
    type: "released_by_florist",
    payload: { florist_id: me.floristId, assignment_id: a.id, reason: b.reason ?? null, detail: b.detail ?? null },
    actor: me.email,
  });

  // Demote the order so the wave engine re-offers the next candidate. CAS from
  // 'accepted' — if it already moved on (e.g. a concurrent staff cancel), the
  // give-back + clawback above already happened and are safe to leave as-is.
  await admin.from("orders").update({ status: "reaching_out" }).eq("id", a.order_id).eq("status", "accepted");

  return Response.json({ ok: true });
}
