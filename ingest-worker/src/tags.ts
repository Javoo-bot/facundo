// Active-order-tags gate — duplicated (intentionally) in
// dashboard/lib/orderTags.ts. The worker and dashboard are separate builds
// with no shared package, so this tiny pure function is kept identical in
// both rather than introducing a cross-build dependency for one helper. If
// you change the semantics here, mirror the change there.
//
// See supabase/migrations/2026-07-26-active-order-tags.sql for the column
// this reads (app_settings.active_order_tags) and its full semantics.

/** Should this order be matched/worked, given the staff-configured "active"
 * tag set?
 *
 * - `activeTags` empty → true for every order (no filtering — today's
 *   behavior, and the default/backward-compatible path).
 * - `activeTags` non-empty → true only if `orderTags` (Shopify's one
 *   comma-separated string, e.g. "24 July 2026, fulfillment-tookan,
 *   new-customer") splits into at least one tag that case-insensitively
 *   matches (after trimming) one of `activeTags`.
 * - `orderTags` null/empty with a non-empty `activeTags` → false (an
 *   untagged order can't match a required tag). */
export function hasActiveTag(orderTags: string | null, activeTags: string[]): boolean {
  if (activeTags.length === 0) return true;
  const active = new Set(
    activeTags.map((t) => t.trim().toLowerCase()).filter(Boolean)
  );
  if (active.size === 0) return true; // an active set of only blanks is effectively "no filter"
  if (!orderTags) return false;
  const orderTagSet = orderTags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return orderTagSet.some((t) => active.has(t));
}

// ---- Working-set predicate ----
// See supabase/migrations/2026-09-10-working-set-settings.sql for the columns
// this reads. Replaces hasActiveTag as the gate that decides whether an order
// gets matched/worked at all (hasActiveTag above is kept unused here now but
// left in place — mirrors dashboard/lib/orderTags.ts, which still uses it for
// unrelated default-display filtering). Mirrored in dashboard/lib/orderTags.ts
// — change both together.

export interface WorkingSetCriteria {
  activeOrderTags: string[];
  activeOrderCountries: string[];
  runAllOrders: boolean;
}

export interface WorkingSetOrderInput {
  tags: string | null;
  /** The order's delivery country — a Shopify shipping country CODE (e.g.
   * "ES"), not a display name. See extractDeliveryCountry. */
  deliveryCountry: string | null;
  /** Non-null/true when staff explicitly added this order to the working set.
   * Manual picks are first-class working-set membership and do not depend on
   * the current automatic country/tag settings. */
  hasExplicitPick?: boolean;
  /** The delivery deadline. Automatic country/tag/run-all membership only
   * applies while this is still in the future, so stale orders do not enter
   * the working set just because settings changed later. Manual picks are
   * still shown/tracked explicitly. */
  deliveryAt?: string | null;
}

/** Upper-cased, trimmed country code, or null if blank/absent. */
export function normalizeCountryCode(country: string | null | undefined): string | null {
  if (!country) return null;
  const trimmed = country.trim().toUpperCase();
  return trimmed.length ? trimmed : null;
}

/** Pulls the Shopify shipping country code out of an order's stored
 * `delivery_address` jsonb (see shopify.ts::parseShopifyOrder, which writes
 * `country: ship.country_code` there). */
export function extractDeliveryCountry(deliveryAddress: Record<string, unknown> | null | undefined): string | null {
  const country = deliveryAddress?.country;
  return typeof country === "string" ? normalizeCountryCode(country) : null;
}

function splitTags(tags: string): string[] {
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

function tagCriterionMatches(orderTags: string | null, activeOrderTags: string[]): boolean {
  const active = new Set(activeOrderTags.map((t) => t.trim().toLowerCase()).filter(Boolean));
  if (active.size === 0 || !orderTags) return false;
  return splitTags(orderTags).some((t) => active.has(t.toLowerCase()));
}

export function isFutureDelivery(deliveryAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!deliveryAt) return true;
  const t = Date.parse(deliveryAt);
  return Number.isNaN(t) ? true : t > now.getTime();
}

/** Should this order be in the working set — i.e. matched/worked at all?
 *
 * - An explicit staff pick (`worklist_at`) -> true, independent of settings.
 * - Automatic membership (`runAllOrders`, tags, countries) applies only while
 *   the delivery time is still in the future.
 * - `runAllOrders` true -> every still-live order.
 * - Otherwise, true if the order's tags intersect `activeOrderTags` OR its
 *   delivery country is in `activeOrderCountries` (either criterion alone is
 *   enough — this is an OR, not an AND).
 * - Both criteria empty (and `runAllOrders` false) -> always false. Unlike
 *   `hasActiveTag`, empty configuration is the SAFE default here — it means
 *   "nothing runs yet", not "everything runs". */
export function isInWorkingSet(order: WorkingSetOrderInput, criteria: WorkingSetCriteria, now: Date = new Date()): boolean {
  if (order.hasExplicitPick) return true;

  // Automatic membership (run-all/country/tag) is only for still-live orders.
  // This keeps changing settings from reviving orders whose delivery deadline
  // has already passed. Staff can still pick an order explicitly if they need
  // to track/close an exceptional case.
  if (!isFutureDelivery(order.deliveryAt, now)) return false;

  if (criteria.runAllOrders) return true;

  const countrySet = new Set(criteria.activeOrderCountries.map((c) => normalizeCountryCode(c)).filter((c): c is string => c != null));
  const hasTagCriterion = criteria.activeOrderTags.some((t) => t.trim().length > 0);
  if (!hasTagCriterion && countrySet.size === 0) return false;

  if (tagCriterionMatches(order.tags, criteria.activeOrderTags)) return true;
  const orderCountry = normalizeCountryCode(order.deliveryCountry);
  return orderCountry != null && countrySet.has(orderCountry);
}
