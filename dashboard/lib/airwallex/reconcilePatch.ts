// Pure "what should a reconcile write" decision, given a live Airwallex
// summary (liveSummary.ts::summarizeLive). Kept separate from any DB access
// so every branch is unit-testable without a fake Supabase client.
//
// SIGN CONVENTION — load-bearing, read before changing anything here.
// `summarizeLive` normalizes Airwallex's spend to a POSITIVE magnitude (see
// its header) because that's what a human reading a drift panel wants. But
// `webhookMap.ts` — the only other writer of `payouts.spent_amount` — stores
// the RAW value straight off the Airwallex payload, which is NEGATIVE (a EUR
// 31.50 purchase posts as billing_amount -31.50). This module writes the same
// convention webhookMap does (raw negative) so a reconciled row is
// byte-for-byte what a working webhook would have written, and so the two
// writers can never disagree about what a stored `spent_amount` MEANS. Getting
// this backwards would make every reconciled payout look like a refund.
//
// `card_status` similarly mirrors webhookMap's vocabulary, not Airwallex's:
// we write "USED" on settlement (matching the "settled" webhook event), never
// Airwallex's own "ACTIVE"/"CLOSED" strings — see liveSummary.ts's header for
// why the two vocabularies don't compare directly.

import type { LiveSummary, TxnRow, AuthRow, StoredPayout } from "./liveSummary.ts";

export type { StoredPayout };

/** Payout statuses this reconcile path is allowed to touch. Deliberately
 *  narrower than liveCheckEligibility's `cardIfLive` (which also treats
 *  'paid' as "eligible for a live read") — a terminal payout (`paid`,
 *  `failed`, `clawed_back`) is scope the task defines as done; reconcile
 *  only ever acts on a card-rail payout still short of that. */
export const RECONCILABLE_STATUSES = ["pending", "issued", "held"] as const;

export function isReconcilableStatus(status: string | null): boolean {
  return status !== null && (RECONCILABLE_STATUSES as readonly string[]).includes(status);
}

export interface ReconcilePatch {
  spent_amount?: number;
  settled_at?: string;
  card_status?: string;
  last_txn_id?: string;
  status?: string;
}

export type ReconcileEventType = "reconciled_settled" | "reconciled_authorized";

export interface ReconcileOutcome {
  /** null when Airwallex shows no spend at all — nothing to reconcile, and
   *  callers MUST NOT advance the payout in that case. */
  patch: ReconcilePatch | null;
  eventType: ReconcileEventType | null;
  eventPayload: Record<string, unknown>;
}

function latestClearedTxnId(txns: TxnRow[]): string | null {
  const clearing = txns.filter(
    (t) => String(t.type ?? "").toUpperCase() === "CLEARING" && String(t.status ?? "").toUpperCase() !== "DECLINED" && t.id,
  );
  return clearing.length ? clearing[clearing.length - 1].id : null;
}

function latestOpenAuthId(auths: AuthRow[]): string | null {
  const withId = auths.filter((a) => a.id);
  return withId.length ? withId[withId.length - 1].id : null;
}

/**
 * Given a live summary, decide what (if anything) to persist.
 *
 *  - Settled (a real cleared amount exists): mirror exactly what webhookMap's
 *    "settled" branch would have written — raw negative spend, card_status
 *    "USED", settled_at now, the cleared txn id, and status advanced to
 *    "paid".
 *  - Authorized only (money is held but hasn't cleared): mirror webhookMap's
 *    "authorized" branch — spend + txn id recorded, status/card_status left
 *    alone (a pending authorization can still fail to clear).
 *  - Nothing spent at all: patch is null. The caller must not advance status
 *    or touch any column — an unspent card looking unspent is not drift.
 */
export function computeReconcilePatch(summary: LiveSummary, nowIso: string): ReconcileOutcome {
  if (summary.clearedTotal !== null && summary.clearedTotal > 0) {
    const txnId = latestClearedTxnId(summary.transactions);
    const rawSpent = -summary.clearedTotal; // webhookMap convention: raw NEGATIVE
    return {
      patch: {
        spent_amount: rawSpent,
        settled_at: nowIso,
        card_status: "USED",
        ...(txnId ? { last_txn_id: txnId } : {}),
        status: "paid",
      },
      eventType: "reconciled_settled",
      eventPayload: { source: "reconcile", clearedTotal: summary.clearedTotal, currency: summary.currency, txnId },
    };
  }

  if (summary.pendingTotal !== null && summary.pendingTotal > 0) {
    const authId = latestOpenAuthId(summary.authorizations);
    return {
      patch: {
        spent_amount: -summary.pendingTotal, // same raw-negative convention
        ...(authId ? { last_txn_id: authId } : {}),
      },
      eventType: "reconciled_authorized",
      eventPayload: { source: "reconcile", pendingTotal: summary.pendingTotal, currency: summary.currency, txnId: authId },
    };
  }

  // Airwallex shows no spend at all — do not touch the row.
  return { patch: null, eventType: null, eventPayload: {} };
}

/**
 * Would applying `patch` actually change anything already stored? Guards a
 * repeating sweep from re-writing (and re-auditing via a fresh payment_events
 * row) the exact same unsettled-authorization state on every tick. A settled
 * payout stops being selected at all once `status` flips to "paid" (see
 * RECONCILABLE_STATUSES), so this mostly matters for the authorized-only
 * branch, which never leaves 'issued'/'pending'/'held'.
 */
export function reconcilePatchChanged(stored: StoredPayout, patch: ReconcilePatch): boolean {
  if (patch.status !== undefined && patch.status !== stored.status) return true;
  if (patch.card_status !== undefined && patch.card_status !== stored.card_status) return true;
  if (patch.spent_amount !== undefined && stored.spent_amount !== patch.spent_amount) return true;
  if (patch.last_txn_id !== undefined && patch.last_txn_id !== stored.last_txn_id) return true;
  return false;
}
