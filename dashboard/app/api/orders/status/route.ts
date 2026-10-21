import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isOrderStatus, type OrderStatus } from "@/lib/orderStatus";
import { canStaffSet, moveDirection } from "@/lib/orderStages";
import { clawbackForOrder } from "@/lib/payout";
import { gateClientEmail } from "@/lib/clientComms";
import { writeOrderStatus } from "@/lib/orderStatusWrite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff manual stage control. Guardrailed (not the strict automatic machine):
// forward moves, sensible back-steps, escalate/cancel from any live state, and
// reopen from terminal — see lib/orderStages.ts::staffSettableStatuses. Every
// write is compare-and-set so a concurrent florist/staff change can't be
// clobbered. Backward moves / cancel that would abandon an issued payout require
// an explicit `confirm` (the money isn't auto-clawed except on cancel).
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string; to?: string; confirm?: boolean };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId || !isOrderStatus(body.to)) return jsonError("orderId and a valid target status are required.", 400);
  const to = body.to as OrderStatus;

  const admin = createServiceClient();
  const { data: order } = await admin.from("orders").select("status").eq("id", body.orderId).single();
  if (!order || !isOrderStatus(order.status)) return jsonError("Order not found.", 404);
  const from = order.status as OrderStatus;
  if (from === to) return Response.json({ ok: true, status: to });
  if (!canStaffSet(from, to)) return jsonError(`Illegal transition ${from} → ${to}.`, 409);

  // Money guard: a backward move or cancel while an accept/delivery leg is issued
  // needs confirmation. Cancel auto-claws back below; a plain backward move does
  // not, so staff must acknowledge the outstanding exposure.
  const dir = moveDirection(from, to);
  if ((dir === "back" || to === "cancelled") && !body.confirm) {
    const { data: as } = await admin.from("order_assignments").select("id").eq("order_id", body.orderId);
    const ids = (as ?? []).map((a) => a.id);
    if (ids.length) {
      const { data: pays } = await admin.from("payouts")
        .select("id").in("assignment_id", ids).in("status", ["issued", "paid"]);
      if (pays && pays.length) {
        const verb = to === "cancelled" ? "Cancelling" : "Moving this order backward";
        return Response.json({
          ok: false,
          needsConfirm: true,
          warning: `${verb} affects ${pays.length} issued payout leg(s).${to === "cancelled" ? " Cancelling will claw them back and close any live cards." : " The payout is not clawed back automatically — handle it via the issue/clawback flow if needed."}`,
        }, { status: 409 });
      }
    }
  }

  // Compare-and-set + event write, shared with the Shopify-conflict resolve
  // route (lib/orderStatusWrite.ts).
  const won = await writeOrderStatus(admin, { orderId: body.orderId, from, to, actor: gate.email });
  if (!won) return jsonError("Order changed — refresh and retry.", 409);

  // Cancel unwinds the money: full clawback + close any live cards (idempotent).
  if (to === "cancelled") {
    await clawbackForOrder(body.orderId, null).catch(() => {});
  }

  // Customer "on the way" notice — semi-gated (files a CX approval in step mode),
  // best-effort, idempotent (client_comms claim), never allowed to fail the status
  // write it rides on.
  if (to === "out_for_delivery") {
    await gateClientEmail(body.orderId, "on_the_way").catch(() => {});
  }

  return Response.json({ ok: true, status: to });
}
