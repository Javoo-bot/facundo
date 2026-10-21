import { requireRole, jsonError } from "@/lib/apiAuth";
import { rejectHeldPayout } from "@/lib/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CX rejects a held payout (bad/insufficient proof) → void it + record why.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("finance", "admin");
  if (!gate.ok) return gate.res;
  let body: { payoutId?: string; reason?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.payoutId) return jsonError("payoutId is required.", 400);

  const r = await rejectHeldPayout(body.payoutId, gate.email, body.reason ?? "rejected by CX");
  if (!r.ok) return jsonError("That payout isn't held (already released/voided?).", 409);
  return Response.json({ ok: true });
}
