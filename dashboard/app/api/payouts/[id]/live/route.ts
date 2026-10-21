// Staff read-through to Airwallex for one payout's card: what the provider
// actually believes happened, next to what we stored.
//
// READ-ONLY BY DESIGN. This route writes nothing to `payouts`. The stored
// spend columns are the webhook's job (lib/airwallex/webhookMap.ts); a manual
// button that also mutated financial state would give us two writers with no
// ordering between them. When this route reports drift, the fix is to repair
// webhook delivery — not to paper over it from the UI.
//
// Returns no sensitive card data (no PAN/CVV) — that stays behind the
// dedicated reveal route with its own audit trail.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError, requireRole } from "@/lib/apiAuth";
import { getCard, getCardAuthorizations, getCardTransactions } from "@/lib/airwallex/cards";
import { cardIfLive } from "@/lib/airwallex/revealGuard";
import { summarizeLive } from "@/lib/airwallex/liveSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const authGate = await requireRole("finance", "admin");
  if (!authGate.ok) return authGate.res;

  const { id } = await params;
  const admin = createServiceClient();
  const { data: p } = await admin
    .from("payouts")
    .select("id, rail, provider_ref, status, card_status, spent_amount, last_txn_id")
    .eq("id", id)
    .single();

  // Same rail / ledger-sentinel / liveness gate the card ops use. Note this
  // refuses clawed_back and failed payouts, matching the reveal path.
  const gate = cardIfLive(p ? { florist_id: null, rail: p.rail, provider_ref: p.provider_ref, status: p.status } : null);
  if (!gate.ok) return jsonError(gate.error, gate.code);

  // One round trip each, in parallel — a card read is cheap and the three are
  // independent. allSettled so a single failing endpoint still yields a useful
  // partial answer rather than an error page.
  const [card, auths, txns] = await Promise.allSettled([
    getCard(gate.cardId),
    getCardAuthorizations(gate.cardId),
    getCardTransactions(gate.cardId),
  ]);

  if (card.status === "rejected" && auths.status === "rejected" && txns.status === "rejected") {
    return jsonError("Could not reach Airwallex right now. Try again shortly.", 502);
  }

  const summary = summarizeLive(
    {
      card: card.status === "fulfilled" ? card.value : null,
      authorizations: auths.status === "fulfilled" ? auths.value?.items ?? [] : [],
      transactions: txns.status === "fulfilled" ? txns.value?.items ?? [] : [],
    },
    {
      status: p!.status ?? null,
      card_status: p!.card_status ?? null,
      spent_amount: p!.spent_amount ?? null,
      last_txn_id: p!.last_txn_id ?? null,
    },
  );

  // Name whichever legs failed, so a partial answer is never mistaken for a
  // complete one (an unreachable transactions endpoint must not read as "no spend").
  const partial = [
    card.status === "rejected" ? "card" : null,
    auths.status === "rejected" ? "authorizations" : null,
    txns.status === "rejected" ? "transactions" : null,
  ].filter(Boolean);

  return Response.json(
    { ...summary, partial, fetchedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
