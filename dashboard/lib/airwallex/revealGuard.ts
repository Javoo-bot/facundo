// Pure authorization gate for revealing a payout card's sensitive details.
// Kept separate from the route so every branch is unit-testable without a DB.
//
// A reveal is allowed only when: the payout exists, belongs to the requesting
// florist, was paid on the card rail with a real Airwallex card_id (not a
// ledger sentinel), and the card is still live (not clawed back / failed).

export interface RevealablePayout {
  florist_id: string | null; // from the joined order_assignment
  rail: string | null;
  provider_ref: string | null;
  status: string | null;
}

export type RevealDecision =
  | { ok: true; cardId: string }
  | { ok: false; code: number; error: string };

// Card-liveness check WITHOUT ownership — shared by the staff/CX card ops
// (staff may act on any florist's card). Returns the card_id or a reason.
export function cardIfLive(payout: RevealablePayout | null): RevealDecision {
  if (!payout) return { ok: false, code: 404, error: "Payout not found." };
  if (payout.rail !== "card" || !payout.provider_ref || payout.provider_ref.startsWith("ledger:")) {
    return { ok: false, code: 409, error: "This payout has no card." };
  }
  if (payout.status === "clawed_back" || payout.status === "failed") {
    return { ok: false, code: 409, error: "This card is no longer active." };
  }
  return { ok: true, cardId: payout.provider_ref };
}

// Florist self-service reveal: ownership FIRST (so a foreign payout returns 403
// regardless of card state — no existence leak), then card-liveness.
export function canRevealCard(payout: RevealablePayout | null, floristId: string): RevealDecision {
  if (!payout) return { ok: false, code: 404, error: "Payout not found." };
  if (!payout.florist_id || payout.florist_id !== floristId) {
    return { ok: false, code: 403, error: "Not your payout." };
  }
  return cardIfLive(payout);
}
