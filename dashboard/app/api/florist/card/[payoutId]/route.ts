// Reveal the sensitive details (PAN/CVV/expiry) of a florist's own payout card.
//
// SECURITY:
//  - auth-gated to a signed-in florist (currentFlorist);
//  - canRevealCard enforces the florist OWNS this payout and it's a live card;
//  - the sensitive values are fetched fresh from Airwallex, returned once over
//    TLS with `Cache-Control: no-store`, and NEVER persisted or logged;
//  - the audit row records only THAT a reveal happened (payout id + who), never
//    the card data.

import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { getSensitiveCardDetails } from "@/lib/airwallex/cards";
import { canRevealCard } from "@/lib/airwallex/revealGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ payoutId: string }> }): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);
  const { payoutId } = await params;

  const admin = createServiceClient();
  const { data: p } = await admin
    .from("payouts")
    .select("id, rail, provider_ref, status, order_assignments(florist_id)")
    .eq("id", payoutId)
    .single();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested join row is untyped by supabase-js
  const floristId = (p as any)?.order_assignments?.florist_id ?? null;
  const gate = canRevealCard(
    p ? { florist_id: floristId, rail: p.rail, provider_ref: p.provider_ref, status: p.status } : null,
    me.floristId,
  );
  if (!gate.ok) return jsonError(gate.error, gate.code);

  let details;
  try {
    details = await getSensitiveCardDetails(gate.cardId);
  } catch {
    // Don't leak the upstream error body — it can echo request context.
    return jsonError("Could not retrieve card details right now. Try again shortly.", 502);
  }

  // Audit the reveal — WITHOUT any sensitive value.
  await admin
    .from("payment_events")
    .insert({ payout_id: payoutId, type: "card_revealed", payload: { by: me.email } })
    .then(() => {}, () => {}); // best-effort; never block the reveal on the audit write

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
