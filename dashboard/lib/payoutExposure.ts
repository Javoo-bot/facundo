// Pure exposure-sum helper for the trust-tier cap guard in payout.ts. Kept
// separate so "does a manual payout count toward the same cap as an
// order-leg payout" is unit-testable without a DB.

export interface ExposureRow {
  id: string;
  amount: number | null;
  florist_id: string | null; // direct FK — only set on manual legs
  order_assignments: { florist_id: string | null } | null; // embed — only set on order legs
}

// Exactly one of order_assignments.florist_id / florist_id is ever set per row —
// payouts_leg_shape_check enforces this in the DB (see the 2026-07-30 migration).
export function outstandingExposure(rows: ExposureRow[], floristId: string, excludePayoutId?: string): number {
  return rows
    .filter((p) => p.id !== excludePayoutId && (p.order_assignments?.florist_id ?? p.florist_id) === floristId)
    .reduce((sum, p) => sum + (p.amount ?? 0), 0);
}
