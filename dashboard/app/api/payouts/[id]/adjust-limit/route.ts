// Staff/Finance action: raise a still-open single-use payout card's spend
// limit IN PLACE (same card, no reissue). Exists for when a florist's payment
// processor bills in a different currency than the card and Airwallex's FX
// conversion at swipe time lands a little over the original EUR limit,
// declining every retry with LIMIT_EXCEEDED — see lib/airwallex/cards.ts's
// updateCardLimit. A reason is mandatory (recorded on payment_events before
// the update, same convention as /api/payouts/manual).

import { requireRole, jsonError } from "@/lib/apiAuth";
import { adjustCardLimit } from "@/lib/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireRole("finance", "admin");
  if (!gate.ok) return gate.res;

  const { id } = await params;
  let body: { amount?: number; reason?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }

  // Round at the boundary, not just in the UI — same reasoning as
  // /api/payouts/manual: the rail issues in minor units, so a value that
  // slipped past the client shouldn't drift from what actually gets charged.
  const amount = Math.round(Number(body.amount) * 100) / 100;
  const reason = (body.reason ?? "").trim();
  if (!Number.isFinite(amount) || amount <= 0) return jsonError("Enter a valid amount.", 400);
  if (!reason) return jsonError("A reason is required to adjust a card's limit.", 400);

  const r = await adjustCardLimit(id, amount, reason, gate.email);
  if (r.ok) return Response.json({ ok: true, newAmount: r.newAmount });
  const msg = r.reason === "not-found" ? "Payout not found."
    : r.reason === "no-card" ? "This payout has no card to adjust."
    : r.reason === "card-inactive" ? "This card is no longer active."
    : r.reason === "not-an-increase" ? "The new limit must be higher than the current one."
    : `Couldn't adjust the card limit — ${r.reason}`;
  return Response.json({ ok: false, reason: r.reason, error: msg }, { status: 409 });
}
