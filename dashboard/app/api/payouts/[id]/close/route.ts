// Staff/CX manual card close — permanently closes a payout card so it can no
// longer be spent (e.g. lost card, fraud, mistaken issue). Allow-list gated.
// Does NOT touch the ledger balance (that's what clawback is for) — this only
// kills the spending instrument, and is audited.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError, requireRole } from "@/lib/apiAuth";
import { closeCard } from "@/lib/airwallex/cards";
import { cardIfLive } from "@/lib/airwallex/revealGuard";
import { captureError } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const authGate = await requireRole("finance", "admin");
  if (!authGate.ok) return authGate.res;
  const user = { email: authGate.email };

  const { id } = await params;
  const admin = createServiceClient();
  const { data: p } = await admin.from("payouts").select("id, rail, provider_ref, status").eq("id", id).single();
  const gate = cardIfLive(p ? { florist_id: null, rail: p.rail, provider_ref: p.provider_ref, status: p.status } : null);
  if (!gate.ok) return jsonError(gate.error, gate.code);

  const res = await closeCard(gate.cardId);
  if (!res.ok) {
    captureError("payout.card_close_failed", new Error(`staff close failed for payout ${id}: ${res.error}`));
    return jsonError("Airwallex could not close the card. Try again shortly.", 502);
  }
  await admin.from("payouts").update({ card_status: "CLOSED" }).eq("id", id);
  await admin.from("payment_events").insert({ payout_id: id, type: "card_closed", payload: { by: user.email, cardId: gate.cardId, source: "staff" } });

  return Response.json({ ok: true, card_status: "CLOSED" });
}
