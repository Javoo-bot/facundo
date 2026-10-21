// Staff-triggered retry of a FAILED payout (order-driven or manual) — same
// underlying retryPayoutRow the outbox drainer calls automatically, just
// exposed as a manual trigger for when a human wants to force it now instead
// of waiting for the next backoff attempt.

import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { retryPayoutRow } from "@/lib/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireRole("finance", "admin");
  if (!gate.ok) return gate.res;
  const { id } = await params;

  const admin = createServiceClient();
  const { data: p } = await admin.from("payouts").select("status").eq("id", id).single();
  if (!p) return jsonError("Payout not found.", 404);
  if (p.status !== "failed") return jsonError("Only a failed payout can be retried.", 409);

  const r = await retryPayoutRow(id, gate.email);
  if (r.added) return Response.json({ ok: true, amount: r.amount, currency: r.currency });
  const msg = r.reason === "paused" ? "Payments are paused (kill switch on)."
    : r.reason === "exposure_capped" ? "Blocked — florist exposure cap reached."
    : r.reason === "insufficient_funds" ? "Blocked — insufficient Airwallex funds."
    : r.reason === "not-failed" ? "Payout is no longer in a failed state."
    : r.reason === "no-assignment" ? "Couldn't resolve the florist for this payout."
    : r.reason === "no-tier" ? "This florist has no trust tier set — assign one before retrying."
    : r.detail ? `Couldn't retry the payout — ${r.detail}`
    : "Couldn't retry the payout.";
  return Response.json({ ok: false, reason: r.reason, error: msg }, { status: 409 });
}
