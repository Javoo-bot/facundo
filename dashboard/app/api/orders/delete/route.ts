import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Soft-delete (or restore) one order OR bulk (orders list "select rows" action)
// — admin only. Never a hard delete: line items, assignments, and payouts stay
// in place for audit; `deleted_at` just hides it from the staff orders list
// (see app/(staff)/orders/page.tsx). A direct link still works and shows a
// "Deleted" banner + Restore.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string; orderIds?: string[]; restore?: boolean };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const ids = body.orderIds?.length ? body.orderIds : body.orderId ? [body.orderId] : [];
  if (!ids.length) return jsonError("orderId or orderIds is required.", 400);

  const admin = createServiceClient();
  const { data: orders } = await admin.from("orders").select("id, order_name").in("id", ids);
  if (!orders?.length) return jsonError("No matching orders found.", 404);

  const restoring = !!body.restore;
  const { error } = await admin.from("orders")
    .update({ deleted_at: restoring ? null : new Date().toISOString() })
    .in("id", orders.map((o) => o.id));
  if (error) return jsonError(`Failed to ${restoring ? "restore" : "delete"} the order${orders.length > 1 ? "s" : ""}: ${error.message}`, 500);

  await admin.from("order_events").insert(
    orders.map((o) => ({
      order_id: o.id, type: restoring ? "restored" : "deleted", actor: gate.email,
      payload: { order_name: o.order_name, bulk: orders.length > 1 },
    })),
  );

  return Response.json({ ok: true, count: orders.length });
}
