// Shopify's order lifecycle, and what our status should become because of it.
//
// SHOPIFY IS THE TRUTH. Our `orders.status` follows it rather than running a
// parallel vocabulary: a Shopify order that is fulfilled or archived is finished,
// so ours becomes `closed`; a cancelled one becomes `cancelled`. There is no
// mirror column for "archived" — our status IS that fact, and the `shopify_closed`
// event records which signal fired.
//
// Deliberately NOT part of parseShopifyOrder: that function's return value is
// written straight to the DB, and these are decision inputs, not columns.
//
// Pure, no I/O — unit-tested in test/shopifyLifecycle.test.ts.

export interface ShopifyLifecycle {
  /** fulfillment_status === "fulfilled" (not "partial"/"restocked"/null). */
  fulfilled: boolean;
  /** Shopify's archive. There is no `archived` field — archiving sets closed_at. */
  archived: boolean;
  cancelled: boolean;
}

const NONE: ShopifyLifecycle = { fulfilled: false, archived: false, cancelled: false };

/** Extract the lifecycle flags from a raw Shopify order payload. Total: any
 *  malformed/absent shape reads as "still open", so a bad payload can never
 *  close a live order. */
export function shopifyLifecycle(raw: unknown): ShopifyLifecycle {
  if (!raw || typeof raw !== "object") return NONE;
  const o = raw as Record<string, unknown>;
  const truthyDate = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  return {
    fulfilled: o.fulfillment_status === "fulfilled",
    archived: truthyDate(o.closed_at),
    cancelled: truthyDate(o.cancelled_at),
  };
}

export type ClosureAction =
  | { kind: "close"; to: "closed" | "cancelled" }
  | { kind: "conflict" }
  | { kind: "none" };

/** Terminal for us — nothing left to align. */
const TERMINAL = ["closed", "cancelled"];

/**
 * What our order status should do, given Shopify's lifecycle.
 *
 * @param hasFloristInFlight a florist holds this order (an `accepted` or
 *   `delivered` assignment). Assignment-based rather than status-based on
 *   purpose: in semi mode a matched order still rests at `received`.
 * @param weFulfilled WE set Shopify's `fulfilled` flag ourselves, at florist
 *   accept time (dashboard/lib/shopifyFulfillment.ts writes it and stamps a
 *   `shopify_fulfilled` order event). Without this the florist rail would
 *   report a conflict on EVERY order the moment it was accepted — see below.
 */
export function orderClosure(
  life: ShopifyLifecycle,
  ourStatus: string,
  hasFloristInFlight: boolean,
  weFulfilled = false
): ClosureAction {
  if (TERMINAL.includes(ourStatus)) return { kind: "none" }; // idempotent
  // A cancellation wins over everything, including the in-flight guard: the
  // orders/cancelled webhook owns the unwind (clawbacks included) and this is
  // only the backstop for a dropped one. Leaving a cancelled order open would
  // be strictly worse than closing it.
  if (life.cancelled) return { kind: "close", to: "cancelled" };
  if (!life.fulfilled && !life.archived) return { kind: "none" };
  // Shopify says done, but one of our florists is holding the order with an
  // accept-leg payout already issued. Taking Shopify's word here would strip a
  // live job out of their app mid-delivery, so a human settles it instead. The
  // Shopify-owned columns are still refreshed by the caller either way — this
  // guards the WORKFLOW, it doesn't dispute the data.
  if (hasFloristInFlight) {
    // …unless the `fulfilled` flag is OUR OWN doing. On the local-florist rail
    // we mark the Shopify order fulfilled at ACCEPT — deliberately, so the shop
    // reflects that the order is being handled — which means "fulfilled + a
    // florist in flight" is the NORMAL state there, not a disagreement. Without
    // this branch every accepted florist order would raise a conflict on the CX
    // desk within one reconcile tick.
    //
    // Narrow on purpose: only the `fulfilled` signal is explained by our write.
    // `archived` (Shopify's closed_at) is still somebody acting in the admin
    // behind our back, so that remains a conflict even when we fulfilled.
    if (weFulfilled && life.fulfilled && !life.archived) return { kind: "none" };
    return { kind: "conflict" };
  }
  return { kind: "close", to: "closed" };
}
