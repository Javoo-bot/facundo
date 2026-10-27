// When a rule-gap cluster becomes a factory card. Pure, no I/O; every number
// is in CLUSTER_RULE. The rule and its sources: docs/agent-factory/cluster-cards.md.
//
// LLMs answer differently each time, so one case, or one bad day, says nothing.
// A cluster earns a card only when it keeps coming back (the owner's persistence
// rule) AND, on each day that counts, it hit more of the day's cases than
// model randomness alone explains (a Wilson score lower bound above a baseline).

/** the owner's values (2026-10-15). Change them here and nowhere else. */
export const CLUSTER_RULE = Object.freeze({
  /** How far back the sweep looks, in Madrid days, today included. Matches
   * app_settings.garden_retention_days: older orders' events are deleted. */
  windowDays: 7,
  /** An occasion is one Madrid day with more than this many cases in the cluster. */
  casesPerOccasionAbove: 20,
  /** Occasions needed for a card. */
  minOccasions: 5,
  /** Different days those occasions must cover. With one-day occasions,
   * minOccasions already implies it; it starts to matter if occasions shrink. */
  minDistinctDays: 3,
  /** The share of a day's cases that randomness alone may put in one cluster. */
  baselineRate: 0.05,
  /** 1.96: the day's rate must beat the baseline at 95% two-sided confidence. */
  z: 1.96,
});

/** Lower end of the Wilson score interval for `hits` out of `n`. Unlike the
 * normal approximation it stays inside [0, 1] and behaves at small n and at
 * rates near 0, which is where a rule gap lives. */
export function wilsonLower(hits, n, z = CLUSTER_RULE.z) {
  if (!n) return 0;
  const p = hits / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/**
 * Whether one cluster earns a card.
 * @param {Map<string, number>} perDay  Madrid day -> the cluster's cases that day
 * @param {Map<string, number>} totals  Madrid day -> every case the garden's agents handled that day
 * @param {string[]} days               the window's days (oldest first)
 */
export function judgeCluster(perDay, totals, days, rule = CLUSTER_RULE) {
  const occasions = [];
  for (const day of days) {
    const cases = perDay.get(day) ?? 0;
    const total = totals.get(day) ?? 0;
    if (cases <= rule.casesPerOccasionAbove || !total) continue;
    const lower = wilsonLower(Math.min(cases, total), total, rule.z);
    if (lower > rule.baselineRate) occasions.push({ day, cases, total, rate: cases / total, lower });
  }
  const distinctDays = new Set(occasions.map((o) => o.day)).size;
  const card = occasions.length >= rule.minOccasions && distinctDays >= rule.minDistinctDays;
  return { card, occasions, distinctDays };
}
