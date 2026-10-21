// Pure decision helpers for the customer-visible Shopify fulfilment writes.
//
// Extracted from lib/shopifyFulfillment.ts for exactly the reason shopifyTags.ts
// was extracted from shopifyWriteback.ts: this file has NO app imports, so
// lib/fulfilmentRules.test.mjs can cover it under plain `node --test`.
// shopifyFulfillment.ts pulls in monitor / supabaseAdmin / externalOps, which
// use extensionless specifiers that node's type-stripping cannot resolve (only
// the Next/webpack bundler can).
//
// Keep this file free of imports. If a helper here needs one, it belongs next
// door instead.

export interface RawFulfillmentOrder {
  id: string;
  status?: string | null;
  requestStatus?: string | null;
  supportedActions?: Array<{ action?: string | null }> | null;
}

/** Read a dry-run's empty-mutation response and say what it proves.
 *
 * The dry run sends fulfillmentCreateV2 with an EMPTY line-item list: Shopify
 * has nothing to fulfil, so no state changes, but the request still passes
 * through auth, scopes and fulfillment-order access. The error that comes back
 * therefore tells us which world we are in:
 *
 *   a VALIDATION complaint about the empty list  -> auth/scope/access are fine,
 *                                                   a real write would land
 *   an access/permission complaint               -> still blocked
 *   no error at all                              -> unexpected; treat as unproven
 *      rather than as success, because an empty
 *      list should never be accepted
 */
export function readDryRunSignal(error: string | null | undefined): {
  wouldSucceed: boolean;
  reason: string;
} {
  if (!error) {
    return { wouldSucceed: false, reason: "Shopify accepted an empty fulfilment — unexpected, treating as unproven" };
  }
  const e = error.toLowerCase();
  if (e.includes("does not have access") || e.includes("access denied") || e.includes("not authorized") || e.includes("permission")) {
    return { wouldSucceed: false, reason: "access/permission refused — the scope or fulfillment-order access is still missing" };
  }
  // Shopify's wording for the empty list has varied ("can't be blank", "must
  // contain", "invalid"); any complaint ABOUT THE INPUT means it got far enough
  // to validate the input, which is exactly what we are trying to prove.
  return { wouldSucceed: true, reason: `input rejected as expected (${error}) — auth, scope and fulfillment-order access all passed` };
}

/** Which fulfillment orders may actually be fulfilled right now.
 *
 * Shopify keeps a FulfillmentOrder per (order, location) and they linger in
 * terminal states. Only OPEN / IN_PROGRESS ones are fulfillable — sending a
 * CLOSED or CANCELLED one back makes the mutation fail wholesale, taking the
 * fulfillable ones down with it. Unknown/missing status is treated as NOT
 * fulfillable: a shape we don't recognise is not something to guess at against
 * a real customer order. */
export function fulfillableOrders(nodes: RawFulfillmentOrder[] | null | undefined): string[] {
  return (nodes ?? [])
    .filter((n) => {
      const s = (n?.status ?? "").toUpperCase();
      return s === "OPEN" || s === "IN_PROGRESS";
    })
    .map((n) => n.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Flatten Shopify's userErrors into one line, or null when there were none.
 *  Shopify returns HTTP 200 for a rejected mutation — the failure is in the
 *  body — so a caller that only checks res.ok reports success on a no-op. */
export function userErrorMessage(errs: unknown): string | null {
  if (!Array.isArray(errs) || errs.length === 0) return null;
  const parts = errs
    .map((e) => {
      const o = (e ?? {}) as { message?: unknown; field?: unknown };
      const field = Array.isArray(o.field) ? o.field.join(".") : o.field;
      const msg = typeof o.message === "string" ? o.message : "unknown error";
      return field ? `${String(field)}: ${msg}` : msg;
    })
    .filter(Boolean);
  return parts.length ? parts.join("; ") : "Shopify rejected the mutation";
}

/** A Shopify numeric id or GID, normalised to a GID of the given type.
 *  Our `orders.shopify_order_id` is stored bare ("1000000000001"), while
 *  GraphQL wants "gid://shopify/Order/1000000000001". */
export function toGid(type: "Order" | "Fulfillment", id: string | number): string {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/${type}/${s}`;
}
