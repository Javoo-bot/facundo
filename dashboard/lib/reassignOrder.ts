import { createServiceClient } from "@/lib/supabaseAdmin";

export interface ReassignResult {
  ok: boolean;
  error?: string;
  status?: string;
  from_florist_id?: string;
  to_florist_id?: string;
}

// Hand an order from its current active florist to the next-ranked candidate.
// Race-locked at every step (first-writer-wins), read-before-mutate so a missing
// candidate aborts cleanly, and rolls back the outgoing assignment if promoting
// the next one loses a race. Promotes to `queued` (NOT `sent`) — the actual
// offer email stays a deliberate, test-mode-gated Send in the reach-out panel.
// Shared by /api/orders/reassign and the issue-resolver so the locks live once.
export async function reassignOrder(orderId: string, actor: string): Promise<ReassignResult> {
  const admin = createServiceClient();

  const { data: order } = await admin.from("orders").select("id, status").eq("id", orderId).single();
  if (!order) return { ok: false, error: "Order not found." };
  if (order.status === "cancelled" || order.status === "closed") return { ok: false, error: `Order is ${order.status}.` };

  // Current active assignment: an accepted or already-delivered one (redeliver
  // resolves a post-delivery issue, where the assignment is 'delivered'), else
  // the leading offered one.
  const { data: accepted } = await admin.from("order_assignments").select("*")
    .eq("order_id", orderId).in("status", ["accepted", "delivered"]).limit(1);
  let current = accepted?.[0] ?? null;
  if (!current) {
    const { data: offered } = await admin.from("order_assignments").select("*")
      .eq("order_id", orderId).in("status", ["sent", "opened"])
      .order("rank", { ascending: true, nullsFirst: false }).limit(1);
    current = offered?.[0] ?? null;
  }
  if (!current) return { ok: false, error: "No active assignment to reassign." };

  // Next candidate — read before mutating so a missing one aborts side-effect-free.
  const { data: nextCandidates } = await admin.from("order_assignments").select("*")
    .eq("order_id", orderId).in("status", ["queued", "candidate"])
    .order("rank", { ascending: true, nullsFirst: false }).limit(1);
  const next = nextCandidates?.[0] ?? null;
  if (!next) return { ok: false, error: "No further candidate to reassign to." };

  const { data: reassignedRows } = await admin.from("order_assignments")
    .update({ status: "reassigned" }).eq("id", current.id).eq("status", current.status).select("id");
  if (!reassignedRows || reassignedRows.length === 0) return { ok: false, error: "Assignment already changed by another action." };

  const { data: promotedRows } = await admin.from("order_assignments")
    .update({ status: "queued" }).eq("id", next.id).eq("status", next.status).select("id");
  if (!promotedRows || promotedRows.length === 0) {
    await admin.from("order_assignments").update({ status: current.status }).eq("id", current.id);
    return { ok: false, error: "Next candidate was already changed by another action." };
  }

  // CAS the order status too — if a concurrent cancel/close landed after our
  // terminal check, don't resurrect a terminal order; roll the assignments back.
  const { data: orderUpdated } = await admin.from("orders").update({ status: "reaching_out" })
    .eq("id", orderId).not("status", "in", "(cancelled,closed)").select("id");
  if (!orderUpdated || orderUpdated.length === 0) {
    await admin.from("order_assignments").update({ status: current.status }).eq("id", current.id);
    await admin.from("order_assignments").update({ status: next.status }).eq("id", next.id);
    return { ok: false, error: "Order changed (now terminal) — reassign aborted." };
  }

  await admin.from("order_events").insert({
    order_id: orderId, type: "reassigned", actor,
    payload: {
      from_assignment_id: current.id, from_florist_id: current.florist_id,
      to_assignment_id: next.id, to_florist_id: next.florist_id,
    },
  });

  return { ok: true, status: "reaching_out", from_florist_id: current.florist_id, to_florist_id: next.florist_id };
}
