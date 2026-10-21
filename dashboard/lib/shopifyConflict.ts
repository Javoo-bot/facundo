// The "Shopify vs. us" conflict raised when Shopify reports an order
// fulfilled/archived while one of our florists still holds it — see
// ingest-worker/src/shopifyLifecycle.ts::orderClosure (the `conflict` branch)
// and ingest-worker/src/lateMatch.ts (writes the one-time `shopify_conflict`
// order event, at most once per order ever). Pure decision logic shared by:
//   - lib/cxAttention.ts — whether the order still belongs in the CX queue.
//   - components/orders/ShopifyConflictResolve.tsx — whether the order detail
//     page shows the resolve affordance, and what its confirm step should say.
// Both staff resolutions (POST /api/orders/shopify-conflict/close and
// .../dismiss) write the SAME `shopify_conflict_resolved` marker event, so one
// presence check covers either outcome.
//
// Pure, no I/O — unit-tested in shopifyConflict.test.mjs.

export const CONFLICT_EVENT = "shopify_conflict";
export const CONFLICT_RESOLVED_EVENT = "shopify_conflict_resolved";

/** Order ids with an unresolved conflict — a `shopify_conflict` event exists
 *  and no `shopify_conflict_resolved` event has been recorded for that order.
 *  Used by cxAttention.ts, which fetches both event types for every order in
 *  one query. */
export function unresolvedConflictOrderIds(rows: { order_id: string; type: string }[]): Set<string> {
  const conflicted = new Set<string>();
  const resolved = new Set<string>();
  for (const r of rows) {
    if (r.type === CONFLICT_EVENT) conflicted.add(r.order_id);
    else if (r.type === CONFLICT_RESOLVED_EVENT) resolved.add(r.order_id);
  }
  for (const id of resolved) conflicted.delete(id);
  return conflicted;
}

/** Same check against a single order's own event list (order detail page /
 *  the resolve routes' own guard). */
export function hasUnresolvedConflict(events: { type: string }[]): boolean {
  let conflicted = false;
  for (const e of events) {
    if (e.type === CONFLICT_RESOLVED_EVENT) return false; // resolution always wins
    if (e.type === CONFLICT_EVENT) conflicted = true;
  }
  return conflicted;
}

export interface ConflictCloseImpact {
  /** Whether there's a live/unsettled assignment the staff user should be told
   *  about before force-closing. False when there's nothing left open (e.g. no
   *  assignment currently accepted/delivered) — closing is then a formality. */
  needsWarning: boolean;
  /** The exact copy to show in the confirm step, or null when needsWarning is
   *  false. Describes what actually happens to the payout/assignment, not a
   *  guess — see app/api/florist/photo/route.ts, which gates only on
   *  order_assignments.status, not orders.status. */
  warning: string | null;
}

/**
 * What "Accept Shopify's truth" (force-close) leaves open, given the leading
 * assignment's live status. Closing the ORDER never touches
 * `order_assignments` or calls into payout.ts itself (see
 * lib/orderStatusWrite.ts::writeOrderStatus — a plain CAS + event write), so:
 *   - the assignment itself stays `accepted`/`delivered` in the florist's app
 *     (app/florist/(app)/page.tsx lists jobs by assignment status only, not
 *     order status);
 *   - if the delivery-leg (30%) payout hasn't fired yet, the florist can still
 *     upload a delivery photo later — POST /api/florist/photo only checks
 *     `order_assignments.status`, so that still succeeds, issues the payout,
 *     AND flips `orders.status` back to `delivered` (undoing the close).
 */
export function describeConflictCloseImpact(o: {
  assignmentStatus: "accepted" | "delivered" | null;
  floristName: string | null;
  hasDeliveryPayout: boolean;
}): ConflictCloseImpact {
  if (o.assignmentStatus !== "accepted" && o.assignmentStatus !== "delivered") {
    return { needsWarning: false, warning: null };
  }
  const who = o.floristName ?? "The assigned florist";
  if (o.hasDeliveryPayout) {
    return {
      needsWarning: true,
      warning: `${who}'s assignment stays "${o.assignmentStatus}" in their app — closing this order only updates our status, it does not touch the assignment or any payout.`,
    };
  }
  return {
    needsWarning: true,
    warning: `${who}'s assignment stays "${o.assignmentStatus}" in their app and the 30% delivery payout hasn't been issued — closing does NOT stop that: if they still upload a delivery photo, the order flips back to "Delivered" and the remaining payout goes out as normal.`,
  };
}
