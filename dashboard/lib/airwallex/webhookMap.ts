// Pure mapping from an Airwallex Issuing webhook event to the effect we apply:
// which payout columns to patch, what to audit, and how to find the payout
// (by card_id). Kept pure so every event type is unit-testable.
//
// Event names (Airwallex Issuing):
//   issuing.transaction.succeeded    — AUTHORIZATION phase, then CLEARING (settled)
//   issuing.transaction.failed       — declined authorization
//   issuing.reissue.succeeded        — card renewed
//   issuing.transaction_dispute.modified / .accepted — dispute status change
// NOTE: exact data field names (transaction_type, card_id, amount) should be
// confirmed against a real sandbox event; the extractor below is defensive.

export interface MappedEvent {
  eventType: string; // audit type written to payment_events
  cardId: string | null; // to locate the payout (payouts.provider_ref)
  txnId: string | null;
  disputeStatus: string | null;
  payoutPatch: Record<string, unknown> | null; // columns to set on the matched payout
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook JSON is untyped
function eventObject(event: any): any {
  return event?.data?.object ?? event?.data ?? {};
}

function toNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Drop undefined keys so a patch never overwrites a column with null.
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook JSON is untyped
export function mapWebhookEvent(event: any, nowIso: string): MappedEvent {
  const name: string = event?.name ?? "";
  const obj = eventObject(event);
  const cardId: string | null = obj.card_id ?? obj.cardId ?? null;
  const txnId: string | null = obj.id ?? obj.transaction_id ?? null;
  const amount = toNum(obj.transaction_amount ?? obj.billing_amount ?? obj.amount);
  const txnType = String(obj.transaction_type ?? obj.type ?? "").toUpperCase();

  switch (name) {
    case "issuing.transaction.succeeded": {
      if (txnType === "CLEARING") {
        return {
          eventType: "settled",
          cardId,
          txnId,
          disputeStatus: null,
          payoutPatch: compact({
            status: "paid",
            settled_at: nowIso,
            spent_amount: amount ?? undefined,
            last_txn_id: txnId ?? undefined,
            card_status: "USED",
          }),
        };
      }
      // AUTHORIZATION phase — the card was spent; record it, keep status 'issued'.
      return {
        eventType: "authorized",
        cardId,
        txnId,
        disputeStatus: null,
        payoutPatch: compact({ spent_amount: amount ?? undefined, last_txn_id: txnId ?? undefined }),
      };
    }
    case "issuing.transaction.failed":
      return { eventType: "declined", cardId, txnId, disputeStatus: null, payoutPatch: null };
    case "issuing.reissue.succeeded":
      return { eventType: "reissued", cardId, txnId, disputeStatus: null, payoutPatch: null };
    case "issuing.transaction_dispute.modified":
    case "issuing.transaction_dispute.accepted": {
      const disputeStatus: string | null =
        obj.status ?? (name.endsWith(".accepted") ? "ACCEPTED" : null);
      return {
        eventType: "dispute",
        cardId,
        txnId,
        disputeStatus,
        payoutPatch: disputeStatus ? { dispute_status: disputeStatus } : null,
      };
    }
    default:
      return { eventType: `unhandled:${name || "unknown"}`, cardId, txnId, disputeStatus: null, payoutPatch: null };
  }
}
