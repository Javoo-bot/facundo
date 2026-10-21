import { hasActiveTag } from "./tags";

// The working set — which orders staff have said the system should actually
// operate on. Duplicated (intentionally) in dashboard/lib/workingSet.ts:
// the worker and dashboard are separate builds with no shared package, so this
// pure module is kept identical in both rather than introducing a cross-build
// dependency. If you change the semantics here, mirror the change there.
// dashboard/lib/workingSet.test.mjs asserts the two files agree.
//
// See supabase/migrations/2026-08-11-order-working-set.sql for the column this
// reads (orders.worklist_at) and the design doc at
// docs/superpowers/specs/2026-08-11-order-working-set-and-perf-design.md.

/** The two inputs that define the working set, read once per page render or
 * worker sweep — never per order. */
export interface WorkingSetConfig {
  /** app_settings.active_order_tags — the standing tag gate. */
  activeTags: string[];
  /** Whether ANY order currently carries a non-null worklist_at. A single
   * indexed head-count; see workingSetConfig() in src/workingSetServer.ts. */
  anyExplicitPicks: boolean;
}

/** Just enough of an order row to judge membership. */
export interface WorkingSetOrder {
  /** Shopify's one comma-separated tag string. */
  tags: string | null;
  /** Non-null = explicitly picked by staff. */
  worklist_at: string | null;
}

/** Is the gate doing anything at all?
 *
 * OFF only when BOTH inputs are empty — that's the backward-compatible default
 * (every order matched and shown, exactly as before the gate existed).
 *
 * The alternative — treating empty tags as "everything" and unioning picks on
 * top — was rejected deliberately: a union with everything is a no-op, so the
 * explicit list would do nothing in exactly the mode where staff most want it
 * ("work these two orders and nothing else"). */
export function isGateActive(cfg: WorkingSetConfig): boolean {
  return cfg.activeTags.some((t) => t.trim().length > 0) || cfg.anyExplicitPicks;
}

/** Should this order be matched/worked (and shown by default)?
 *
 * - Gate off (no tags, no picks) → true for every order.
 * - Gate on → true if the order was explicitly picked, OR its Shopify tags
 *   intersect the active tag set. The union, not the intersection.
 *
 * An order that fails is still ingested and still visible in the full orders
 * list — it just isn't auto-worked. Same contract the tag gate always had. */
export function isInWorkingSet(order: WorkingSetOrder, cfg: WorkingSetConfig): boolean {
  if (!isGateActive(cfg)) return true;
  if (order.worklist_at != null) return true;
  // hasActiveTag returns true for an empty active set — which would wrongly
  // admit everything once the gate is on via picks alone. Guard it here so the
  // "empty tags + picks = only the picks" row of the semantics table holds.
  const tags = cfg.activeTags.map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) return false;
  return hasActiveTag(order.tags, tags);
}

/** Order names as staff paste them — "#2000018, #2000026", newline- or
 * comma-separated, `#` optional — normalised to the `#1234567` form
 * `orders.order_name` actually stores.
 *
 * Returns deduped names in input order. Anything that isn't a plausible order
 * number (letters, punctuation) is dropped rather than sent to the DB as a
 * doomed lookup; the caller reports the unresolved ones back to the user. */
export function parseOrderNames(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of input.split(/[\s,;]+/)) {
    const trimmed = piece.trim().replace(/^#+/, "");
    if (!trimmed || !/^\d+$/.test(trimmed)) continue;
    const name = `#${trimmed}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Terminal statuses whose orders fall out of the working set automatically
 * (the reconcile sweep nulls their worklist_at). Mirrors TERMINAL_COMPLETED in
 * dashboard/app/(staff)/orders/page.tsx — keep them in step. */
export const WORKING_SET_TERMINAL = ["paid", "closed", "cancelled", "delivered"] as const;
