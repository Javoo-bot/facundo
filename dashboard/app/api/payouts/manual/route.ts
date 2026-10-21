// Admin-only ad-hoc card issuance to a florist, with no order behind it.
// A reason is mandatory (recorded on payment_events before the issue attempt,
// same convention as /api/orders/payout/release-without-photo).

import { requireRole, jsonError } from "@/lib/apiAuth";
import { issueManualPayout } from "@/lib/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let body: { floristId?: string; amount?: number; reason?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }

  const floristId = body.floristId;
  // Round at the boundary, not just in the UI: the rail issues in minor units
  // (Math.round(amount * 100)), so a 12.345 that slipped past the client would
  // be stored as 12.345 on the payout row but charged as 12.35 — the ledger and
  // the card would disagree.
  const amount = Math.round(Number(body.amount) * 100) / 100;
  const reason = (body.reason ?? "").trim();
  if (!floristId) return jsonError("floristId is required.", 400);
  if (!Number.isFinite(amount) || amount <= 0) return jsonError("Enter a valid amount.", 400);
  if (!reason) return jsonError("A reason is required to issue a manual card.", 400);

  const r = await issueManualPayout({ floristId, amount, currency: "EUR", reason, actor: gate.email });
  if (r.added) return Response.json({ ok: true, amount: r.amount, currency: r.currency });
  const msg = r.reason === "paused" ? "Payments are paused (kill switch on)."
    : r.reason === "exposure_capped" ? "Blocked — florist exposure cap reached."
    : r.reason === "insufficient_funds" ? "Blocked — insufficient Airwallex funds."
    : r.reason === "no-tier" ? "This florist has no trust tier set — assign one before issuing a card."
    : r.detail ? `Couldn't issue the card — ${r.detail}`
    : "Couldn't issue the card.";
  return Response.json({ ok: false, reason: r.reason, error: msg }, { status: 409 });
}
