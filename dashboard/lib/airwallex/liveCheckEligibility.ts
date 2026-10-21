// Pure triage for the payments-list "is this payout's stored card state
// possibly stale?" batch view (Batch 1 of the payments-visibility audit).
//
// This module writes nothing. It answers two separate questions:
//
//   1. Is this payout even ELIGIBLE for a live Airwallex read at all? Same
//      question `cardIfLive` (revealGuard.ts) already answers for the
//      single-payout route — reused verbatim here so the two surfaces can
//      never disagree about which payouts have a real, live card behind
//      them. `assessLiveCheckEligibility`'s `reason` breakdown is purely a
//      display convenience on top of that boolean; it mirrors cardIfLive's
//      two failure branches (no card / card no longer active) and MUST be
//      kept in sync if revealGuard.ts's conditions ever change.
//   2. Of the eligible ones, which look like the exact 2026-08-11 incident
//      shape (see liveSummary.ts's header) — a card-rail payout Airwallex
//      has told us literally nothing about since issue (`card_status` still
//      null)? `needsLiveCheck` is that flag. It is NOT a generic staleness
//      heuristic (no persisted last-checked timestamp exists yet — see the
//      design doc's follow-ups); a card we've since heard from (any non-null
//      card_status, however old) doesn't trip it.

import { cardIfLive, type RevealablePayout } from "./revealGuard.ts";
import { summarizeLive, type LiveInput, type LiveSummary, type StoredPayout } from "./liveSummary.ts";

export interface PayoutRailStatus {
  rail: string | null;
  provider_ref: string | null;
  status: string | null;
  is_test_shop?: boolean | null;
}

export type SkipReason = "ledger_or_no_card" | "card_inactive" | "test_shop";

export type LiveCheckEligibility = { eligible: true; cardId: string } | { eligible: false; reason: SkipReason };

// The eligible/not-eligible boolean comes from cardIfLive(...) verbatim — see
// header. `reason` just re-derives which of cardIfLive's two branches fired,
// for display; it does not gate anything itself.
export function assessLiveCheckEligibility(payout: PayoutRailStatus): LiveCheckEligibility {
  // Test/demo shops are one of the strongest safety boundaries in the payout
  // system: they must never trigger a real provider read/write. In normal
  // issue flow they get ledger refs, but keep this explicit so a bad row can't
  // turn a demo shop into a live Airwallex call from the manual checker.
  if (payout.is_test_shop === true) return { eligible: false, reason: "test_shop" };

  const revealable: RevealablePayout = {
    florist_id: null,
    rail: payout.rail,
    provider_ref: payout.provider_ref,
    status: payout.status,
  };
  const gate = cardIfLive(revealable);
  if (gate.ok) return { eligible: true, cardId: gate.cardId };

  // Mirrors cardIfLive's two failure branches, in the same order.
  const noCard = payout.rail !== "card" || !payout.provider_ref || payout.provider_ref.startsWith("ledger:");
  return { eligible: false, reason: noCard ? "ledger_or_no_card" : "card_inactive" };
}

export interface PayoutCardSignal extends PayoutRailStatus {
  card_status: string | null;
}

// True only for card-rail, still-active payouts where card_status is NULL —
// i.e. Airwallex has told us literally nothing since the card was issued.
// This is the exact shape of the 2026-08-11 incident (see liveSummary.ts's
// header): three issued cards, card_status still null, one fully drawn down.
// This is NOT a generic "looks old" heuristic — there is no persisted
// last-checked timestamp yet (see the design doc's follow-ups).
export function needsLiveCheck(payout: PayoutCardSignal): boolean {
  const eligibility = assessLiveCheckEligibility(payout);
  return eligibility.eligible && payout.card_status === null;
}

export interface LiveCheckRow {
  id: string;
  rail: string | null;
  provider_ref: string | null;
  status: string | null;
  is_test_shop?: boolean | null;
  card_status: string | null;
  spent_amount: number | null;
  last_txn_id: string | null;
}

export interface LiveCheckSelection {
  eligible: { id: string; cardId: string; needsCheck: boolean }[];
  skipped: { id: string; reason: SkipReason }[];
}

// Read-only triage over a batch of payouts. No I/O.
export function selectForLiveCheck(payouts: LiveCheckRow[]): LiveCheckSelection {
  const eligible: LiveCheckSelection["eligible"] = [];
  const skipped: LiveCheckSelection["skipped"] = [];

  for (const p of payouts) {
    const eligibility = assessLiveCheckEligibility(p);
    if (eligibility.eligible) {
      eligible.push({ id: p.id, cardId: eligibility.cardId, needsCheck: needsLiveCheck(p) });
    } else {
      skipped.push({ id: p.id, reason: eligibility.reason });
    }
  }

  return { eligible, skipped };
}

export interface BulkLiveCheckRow {
  id: string;
  eligible: boolean;
  reason?: SkipReason;
  summary?: LiveSummary;
  partial?: string[];
  error?: string;
}

// `fetchLive` is injected so this stays pure/testable — the API route wires
// it to the real getCard/getCardAuthorizations/getCardTransactions reads;
// tests pass a fake that never touches the network. Never mutates `payouts`
// or writes anything. Skipped (ineligible) rows are included in the result
// with eligible:false and a reason, never silently dropped.
export async function bulkLiveCheck(
  payouts: LiveCheckRow[],
  fetchLive: (cardId: string) => Promise<{ card: unknown; authorizations: unknown[]; transactions: unknown[]; partial: string[] }>,
): Promise<BulkLiveCheckRow[]> {
  const { eligible, skipped } = selectForLiveCheck(payouts);
  const byId = new Map(payouts.map((p) => [p.id, p]));

  // Run concurrently, but each row's fetch/summarize is wrapped in its own
  // try/catch so a single failing id can't lose track of which id it was, and
  // can't take the rest of the batch down with it (no bare Promise.allSettled
  // over the whole thing — we need the id kept next to its own outcome).
  const eligibleResults = await Promise.all(
    eligible.map(async (e): Promise<BulkLiveCheckRow> => {
      const stored = byId.get(e.id);
      try {
        const live = await fetchLive(e.cardId);
        const summary = summarizeLive(live as unknown as LiveInput, {
          status: stored?.status ?? null,
          card_status: stored?.card_status ?? null,
          spent_amount: stored?.spent_amount ?? null,
          last_txn_id: stored?.last_txn_id ?? null,
        } satisfies StoredPayout);
        return { id: e.id, eligible: true, summary, partial: live.partial };
      } catch {
        return { id: e.id, eligible: true, error: "Could not reach Airwallex right now." };
      }
    }),
  );

  const skippedResults: BulkLiveCheckRow[] = skipped.map((s) => ({ id: s.id, eligible: false, reason: s.reason }));

  return [...eligibleResults, ...skippedResults];
}
