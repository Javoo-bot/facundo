// Staff/CX reveal of a payout card's sensitive details — so CX can read the
// PAN/CVV to a florist who's stuck. Allow-list gated (not florist-scoped:
// staff may act on any card). Same non-persist / no-store / audit-without-values
// rules as the florist self-service reveal.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError, requireRole } from "@/lib/apiAuth";
import { getSensitiveCardDetails } from "@/lib/airwallex/cards";
import { cardIfLive } from "@/lib/airwallex/revealGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const authGate = await requireRole("finance", "admin");
  if (!authGate.ok) return authGate.res;
  const user = { email: authGate.email };

  const { id } = await params;
  const admin = createServiceClient();
  const { data: p } = await admin.from("payouts").select("id, rail, provider_ref, status").eq("id", id).single();
  const gate = cardIfLive(p ? { florist_id: null, rail: p.rail, provider_ref: p.provider_ref, status: p.status } : null);
  if (!gate.ok) return jsonError(gate.error, gate.code);

  let details;
  try {
    details = await getSensitiveCardDetails(gate.cardId);
  } catch {
    return jsonError("Could not retrieve card details right now. Try again shortly.", 502);
  }

  await admin
    .from("payment_events")
    .insert({ payout_id: id, type: "card_revealed_staff", payload: { by: user.email } })
    .then(() => {}, () => {});

  return Response.json(
    {
      card_number: details.card_number,
      cvv: details.cvv,
      expiry_month: details.expiry_month,
      expiry_year: details.expiry_year,
      name_on_card: details.name_on_card ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
