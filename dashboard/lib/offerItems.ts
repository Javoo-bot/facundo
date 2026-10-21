// Which line item is the thing to MAKE, and which are things to PUT IN THE BOX.
//
// The offer page leads with one large photo of the bouquet and lists everything
// else beneath it. That only works if we pick the hero deliberately:
// `order_line_items` has no guaranteed sort, so the row order alone must not
// decide. A real production order (#2000018) arrives as
// ["Sandy" (a teddy bear), "I Love You" (a €5.90 card), "Roses's Elegance"] —
// leading with the first row would show the florist a teddy bear and bury the
// roses they are being paid to arrange.
//
// `product_type` LOOKS like the answer and is not: 988 of 1000 production rows
// say "bouquet", including every greeting card and soft toy. It carries no
// signal, so it is deliberately not consulted here.
//
// Two signals do work, measured over all 191 multi-item production orders:
//
//   1. `bouquet_spec` — the floral recipe. 71 of those orders have exactly one
//      item carrying one, and an item with a stem list is definitionally the
//      arrangement to make.
//   2. Price. In all 71 of those orders the recipe item is ALSO the priciest —
//      perfect agreement — which is what makes price a safe fallback for the
//      other 120, where no item has a recipe at all. Add-ons cluster at
//      €5.90–7.90; bouquets run €45–85.
//
// Pure and dependency-free (relative imports only) so plain `node --test` can
// exercise it — same convention as lib/reachout.ts and lib/lateAccept.ts.

/** The subset of an order line item this module needs. Structural rather than
 *  the full `OrderLineItem`, so the tests can build fixtures by hand. */
export interface PartitionableItem {
  bouquet_spec: string | null;
  line_total: number | null;
  unit_price: number | null;
}

/** True when the item carries a floral recipe. */
export function hasRecipe(item: PartitionableItem): boolean {
  return !!(item.bouquet_spec ?? "").trim();
}

/** What the customer paid for the line. `line_total` first (it accounts for
 *  quantity), `unit_price` as the fallback, 0 when we hold neither — an
 *  unpriced row should never outrank a priced one. */
export function itemValue(item: PartitionableItem): number {
  const v = item.line_total ?? item.unit_price ?? 0;
  return Number.isFinite(v) ? v : 0;
}

export interface OfferItemSplit<T> {
  /** The item to photograph large. Null only for an order with no items. */
  hero: T | null;
  /** Everything else, most valuable first. */
  alsoInclude: T[];
}

/**
 * Split an order's line items into the hero and the rest.
 *
 * 1. If any item carries a recipe, the hero is the priciest of those.
 * 2. Otherwise the hero is the priciest item overall.
 * 3. Ties resolve to the earliest row, so the page never reshuffles between
 *    renders of the same order.
 *
 * The remainder is ordered by value, descending — a second real bouquet
 * therefore precedes a €5.90 card without either being typed as such.
 */
export function splitOfferItems<T extends PartitionableItem>(items: readonly T[]): OfferItemSplit<T> {
  if (items.length === 0) return { hero: null, alsoInclude: [] };

  const indexed = items.map((item, index) => ({ item, index }));
  const withRecipe = indexed.filter((x) => hasRecipe(x.item));
  const pool = withRecipe.length > 0 ? withRecipe : indexed;

  // Max by value, earliest row wins a tie (strict > keeps the first).
  const heroEntry = pool.reduce((best, x) => (itemValue(x.item) > itemValue(best.item) ? x : best));

  const alsoInclude = indexed
    .filter((x) => x.index !== heroEntry.index)
    // Stable: Array.prototype.sort is stable in every supported engine, so
    // equal-value rows keep their original relative order.
    .sort((a, b) => itemValue(b.item) - itemValue(a.item))
    .map((x) => x.item);

  return { hero: heroEntry.item, alsoInclude };
}
