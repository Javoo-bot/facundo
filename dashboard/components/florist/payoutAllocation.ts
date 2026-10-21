/** Allocates a single assignment payout across an order's bouquet line
 * items, proportional to each item's `line_total` (share = line_total /
 * sum(line_total)). Rounds each share to 2 decimals and nudges the last
 * item so the parts sum exactly to `payoutPrice` (no rounding drift).
 *
 * Guards: a null `payoutPrice`, an empty item list, or a non-positive sum of
 * line totals (all null/zero) all return `null` for every item — the caller
 * shows "—" per item rather than fabricating a split or producing NaN. */
export function allocatePayout(lineTotals: (number | null)[], payoutPrice: number | null): (number | null)[] {
  if (payoutPrice == null || lineTotals.length === 0) return lineTotals.map(() => null);

  const totals = lineTotals.map((t) => (t != null && t > 0 ? t : 0));
  const sum = totals.reduce((s, t) => s + t, 0);
  if (sum <= 0) return lineTotals.map(() => null);

  const shares = totals.map((t) => Math.round(((payoutPrice * t) / sum) * 100) / 100);
  const allocated = shares.reduce((s, v) => s + v, 0);
  const drift = Math.round((payoutPrice - allocated) * 100) / 100;
  shares[shares.length - 1] = Math.round((shares[shares.length - 1] + drift) * 100) / 100;
  return shares;
}
