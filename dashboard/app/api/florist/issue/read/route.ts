import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Clears the florist-unread flag on this order's issues (called when the florist
// opens the order / messages thread). Scoped to the florist's own assignments.
export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);

  let b: { orderId?: string };
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!b.orderId) return jsonError("orderId is required.", 400);

  const admin = createServiceClient();
  const { data: mine } = await admin.from("order_assignments")
    .select("id").eq("order_id", b.orderId).eq("florist_id", me.floristId);
  const ids = (mine ?? []).map((a) => a.id);
  if (ids.length === 0) return Response.json({ ok: true }); // nothing of theirs here

  await admin.from("order_issues").update({ florist_unread: false })
    .eq("order_id", b.orderId).in("assignment_id", ids).eq("florist_unread", true);
  return Response.json({ ok: true });
}
