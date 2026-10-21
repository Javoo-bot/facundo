// Turning `?from=…&to=…` into a StatsRange, for every /statistics route.
//
// Extracted from app/(staff)/statistics/page.tsx when the funnel became a
// second route: the two views share a date-range control that copies the params
// across, so parsing them two ways would let the same URL mean two different
// windows. Pure and alias-free, so `node --test` reaches it directly.

import { defaultRange, type StatsRange } from "./opsStats.ts";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Falls back to the last-30-days default when absent or malformed — a
 * hand-edited URL, or a range whose end precedes its start. Deliberately silent
 * about it: a stats page that refuses to render because someone truncated a
 * pasted link is worse than one that shows the default month.
 */
export function parseStatsRange(sp: Record<string, string | string[] | undefined>): StatsRange {
  const from = typeof sp.from === "string" ? sp.from : undefined;
  const to = typeof sp.to === "string" ? sp.to : undefined;
  if (from && to && ISO_DATE_RE.test(from) && ISO_DATE_RE.test(to) && from <= to) {
    return { from, to };
  }
  return defaultRange();
}
