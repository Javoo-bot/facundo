import type { Payout } from "./types";

// What a florist has actually been paid vs. what's still in flight, derived from
// their payout rows. Kept pure + separate from `computeBalance` (which is the net
// owed) so the earnings summary and the ledger can't drift apart.
export interface Earnings {
  paidOut: number; // released to the florist (status 'paid')
  inProgress: number; // issued or held — owed but not yet released
  net: number; // paid + issued − clawed_back (matches computeBalance)
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeEarnings(payouts: Pick<Payout, "status" | "amount">[]): Earnings {
  let paidOut = 0, inProgress = 0, net = 0;
  for (const p of payouts) {
    const amt = p.amount ?? 0;
    if (p.status === "paid") { paidOut += amt; net += amt; }
    else if (p.status === "issued" || p.status === "held") { inProgress += amt; net += amt; }
    else if (p.status === "clawed_back") { net += amt; } // stored negative
  }
  return { paidOut: round2(paidOut), inProgress: round2(inProgress), net: round2(net) };
}

// The florist-facing meaning of each trust tier (codes 1–4 after the rename).
// Standing is the one thing a florist most wants to know — "how much of my money
// lands when, and why" — so we say it plainly rather than exposing a bare code.
//
// CAREFUL: these blurbs describe a tier's split, and the splits are EDITABLE at
// runtime from /settings. That is not hypothetical — tier 1 was moved from 70/30
// to 100/0 in the database and this map kept telling those florists that "most"
// of their payout lands on accept, when in fact all of it did. So the map is the
// fallback, not the authority: pass the tier's real split to `standingFor` and a
// single-payment tier gets the single-payment blurb whatever its code is.
export const TIER_STANDING: Record<string, { label: string; blurb: string }> = {
  "1": { label: "Trusted", blurb: "Most of your payout lands the moment you accept." },
  "2": { label: "Known", blurb: "Your payout is split evenly between accept and a delivered photo." },
  "3": { label: "New", blurb: "Your payout is released once the delivered photo is approved." },
  "4": { label: "Under review", blurb: "Payouts are briefly held for a quick review while we get to know you." },
};

/** The standing shown to a florist whose tier pays everything on accept.
 *
 * Both halves of the deal, deliberately. Saying only "your whole payout lands
 * when you accept" invites exactly one wrong conclusion — "so I do not need to
 * send a photo any more" — and the photo is the only proof of delivery we get. */
export const PAID_IN_FULL_STANDING = {
  label: "Paid in full",
  blurb: "Your whole payout lands the moment you accept. Your delivery photo is still needed as proof, not for payment.",
};

/** `singlePayment` comes from the tier row via lib/payoutMath.ts::isSinglePayment
 * — the caller has already read the tier to render the balance, so it costs
 * nothing and it means this copy can never contradict the money again. Omitted,
 * it falls back to the per-code map above. */
export function standingFor(
  tierCode: string | null | undefined,
  opts: { singlePayment?: boolean } = {}
): { label: string; blurb: string } {
  if (opts.singlePayment) return PAID_IN_FULL_STANDING;
  return (tierCode && TIER_STANDING[tierCode]) || { label: "Getting started", blurb: "Complete a few orders to build your standing." };
}
