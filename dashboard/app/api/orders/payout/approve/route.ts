import { requireRole, jsonError } from "@/lib/apiAuth";
import { releaseHeldPayout } from "@/lib/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CX approves a held payout → release it. Re-checks the kill switch + exposure/funds.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("finance", "admin");
  if (!gate.ok) return gate.res;
  let body: { payoutId?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.payoutId) return jsonError("payoutId is required.", 400);

  const r = await releaseHeldPayout(body.payoutId, gate.email);
  if (!r.added) {
    const msg = r.reason === "not-held" ? "That payout isn't held (already released?)."
      : r.reason === "paused" ? "Payments are paused (kill switch on)."
      : r.reason === "exposure_capped" ? "Blocked — florist exposure cap reached."
      : r.reason === "insufficient_funds" ? "Blocked — insufficient Airwallex funds."
      : r.detail ? `Couldn't release the payout — ${r.detail}`
      : "Couldn't release the payout.";
    return Response.json({ ok: false, reason: r.reason, error: msg }, { status: 409 });
  }
  return Response.json({ ok: true, amount: r.amount, currency: r.currency });
}
