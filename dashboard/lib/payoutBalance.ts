// Single source of truth for a florist's payout balance.
//
// The balance is the net of what's owed: issued + paid legs are positive,
// `held` legs are money the florist has earned but that's parked pending a quick
// CX release (so they're owed, and must count — see lib/floristStanding.ts, which
// shows the same held amount as "on the way"; excluding it here made the headline
// balance and the earnings summary disagree on the same screen). `clawed_back`
// rows are stored NEGATIVE and must be included so a clawback actually reduces the
// balance. `pending` and `failed` don't count (no money moved). This was
// previously computed inline in two places, one of which dropped `clawed_back` —
// so clawbacks never reduced the shown balance.

import type { Payout } from "./types";

const COUNTED = new Set<Payout["status"]>(["issued", "paid", "held", "clawed_back"]);

export function countsTowardBalance(status: Payout["status"]): boolean {
  return COUNTED.has(status);
}

export function computeBalance(payouts: Pick<Payout, "status" | "amount">[]): number {
  const sum = payouts
    .filter((p) => COUNTED.has(p.status))
    .reduce((s, p) => s + (p.amount ?? 0), 0);
  // Round to cents — guards against floating-point drift from summing decimals.
  return Math.round(sum * 100) / 100;
}
