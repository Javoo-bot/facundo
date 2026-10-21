import { requireRole, jsonError } from "@/lib/apiAuth";
import { reassignOrder } from "@/lib/reassignOrder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId) return jsonError("orderId is required.", 400);

  const result = await reassignOrder(body.orderId, gate.email);
  if (!result.ok) return jsonError(result.error ?? "Reassign failed.", 409);
  return Response.json(result);
}
