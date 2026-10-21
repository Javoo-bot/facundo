import type { CxAttentionRow } from "./cxAttention";

// Pure decision logic for the CX alert sweep (dashboard/lib/cxAlerts.ts),
// split into its own zero-I/O module so it can be unit-tested with plain
// `node --test` (no path-alias/bundler resolution needed — see
// lib/cxAlerts.test.mjs) the same way lib/scoring.ts and lib/orderStages.ts
// are.

export const BREACH_URGENCY_THRESHOLD = 75;
export const ALERT_THROTTLE_MINUTES = 15;

// A row is page-worthy if its top reason is at/above the urgency bar, OR ANY
// of its reasons carries an SLA deadline that has already passed (urgency
// alone can under-count a just-breached SLA before overdueBonus accumulates).
export function isBreaching(row: CxAttentionRow, nowIso: string): boolean {
  if (row.urgency >= BREACH_URGENCY_THRESHOLD) return true;
  return [row.primary, ...row.others].some((r) => r.slaAt != null && r.slaAt < nowIso);
}

// Stable, order-independent signature of the breaching order set. Changes the
// instant an order enters or leaves the set, so a transition always re-alerts
// regardless of the throttle window — only an UNCHANGED set gets throttled.
// (A 32-bit rolling hash is plenty here: collisions just mean a rare missed
// immediate re-alert, which the throttle window's periodic re-alert catches
// anyway — never a false silence beyond one window.)
export function hashBreachingSet(rows: CxAttentionRow[]): string {
  const ids = [...rows.map((r) => r.orderId)].sort();
  const joined = ids.join(",");
  let h = 0;
  for (let i = 0; i < joined.length; i++) h = (Math.imul(h, 31) + joined.charCodeAt(i)) | 0;
  return `${ids.length}:${h}`;
}
