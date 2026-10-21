import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { sendFloristMagicLink } from "@/lib/floristMagicEmail";
import { orderDest } from "@/lib/floristMagicLink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Email a florist a one-tap sign-in link — either to their inbox (`/florist`)
// or straight to a single order, when `assignmentId` is given.
//
// The destination is NEVER taken from the request body: a caller supplies an
// assignment id and the server derives the path from it. A client-supplied
// `dest` would be an open-redirect surface on a URL that carries a credential.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { floristId?: string; assignmentId?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.floristId) return jsonError("floristId is required.", 400);

  let dest: string | undefined;
  let orderId: string | null = null;
  let orderLabel: string | null = null;
  let assignmentId: string | null = null;

  if (body.assignmentId) {
    const admin = createServiceClient();
    const { data: a } = await admin
      .from("order_assignments")
      .select("id, order_id, florist_id, orders(order_name)")
      .eq("id", body.assignmentId)
      .single();
    if (!a) return jsonError("Assignment not found.", 404);
    // The assignment must belong to the florist we're emailing, or the link
    // would sign them in to somebody else's order.
    if (a.florist_id !== body.floristId) return jsonError("That order isn't assigned to this florist.", 409);
    assignmentId = a.id as string;
    orderId = a.order_id as string;
    dest = orderDest(a.id as string);
    const ord = a.orders as { order_name?: string | null } | { order_name?: string | null }[] | null;
    orderLabel = (Array.isArray(ord) ? ord[0]?.order_name : ord?.order_name) ?? null;
  }

  const r = await sendFloristMagicLink(body.floristId, gate.email, { dest, orderId, orderLabel, assignmentId });
  if (!r.ok) {
    if (r.error === "florist-not-found") return jsonError("Florist not found.", 404);
    if (r.error === "florist-no-email") return jsonError("That florist has no email address on file.", 400);
    if (r.error === "no-test-email") return jsonError("Test mode is on but no valid test email is set (Settings).", 400);
    if (r.error === "bad-dest") return jsonError("Invalid link destination.", 400);
    if (r.error === "cooling-down") return jsonError("A sign-in link was just sent. Give it a moment before sending another.", 429);
    return jsonError(`Could not send the link: ${r.error}`, 502);
  }
  return Response.json({ ok: true, to: r.to, test_mode: r.testMode, test_shop: r.testShop, placeholder: r.placeholder });
}
