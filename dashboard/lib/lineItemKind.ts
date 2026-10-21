// What an order line item actually IS — a vase, a greeting card, chocolates —
// so the florist reads "Greeting card · I Love You" instead of a bare "I Love
// You" and has to guess.
//
// NOT from `product_type`: 988 of 1000 production rows say "bouquet", including
// every card and vase. That field carries no signal (see lib/offerItems.ts).
//
// The BARCODE does. Shopify writes `FC-AD/<PREFIX><code>_<size>` for an add-on
// and `FC-<PREFIX>...` for the product itself, and the prefix names the type.
// Measured over all 1000 production line items (984 carry a barcode):
//
//   AD/CD  560 rows  Happy Birthday · I Love You · True Words · Love !!
//   AD/CM  119 rows  Sandy · Marble · Emerald
//   AD/VS   19 rows  Candy · Scarlet
//   AD/CH    2 rows  Lindt Flower · Lindt Mini Pralines
//   AD/BR    1 row   Teddy
//
// and the non-add-on prefixes (FC, BK, PL, PLFC) are the arrangements
// themselves. No `AD/` row anywhere carries a `bouquet_spec`, which is
// consistent with lib/offerItems.ts treating a recipe as the bouquet signal.
//
// Pure and dependency-free (relative imports only) so plain `node --test` can
// exercise it.

/** What an add-on is, as a stable code rather than a word. The florist app
 *  renders these in six languages, so the label is the caller's business — this
 *  module only knows WHICH thing it is. */
export type AddonKind = "card" | "vase" | "chocolates" | "teddy";

/** Add-on prefixes we can name with confidence. An unrecognised prefix returns
 *  null rather than a guess — a wrong label ("Vase — Lindt Pralines") is worse
 *  for the florist packing the box than no label at all. */
const ADDON_KIND: Record<string, AddonKind> = {
  CD: "card",
  CM: "vase",
  VS: "vase",
  CH: "chocolates",
  BR: "teddy",
};

/** The English wording, and the default for callers with no translator to hand
 *  (staff screens, tests). The florist app passes `t()` instead — see
 *  components/florist/offer/OfferItems.tsx. */
export const EN_KIND_LABEL: Record<AddonKind, string> = {
  card: "Greeting card",
  vase: "Vase",
  chocolates: "Chocolates",
  teddy: "Teddy bear",
};

/** `FC-AD/CD30065_L` → "CD". Null when the barcode is missing or isn't an
 *  add-on barcode at all (the arrangement itself, or an unparseable value). */
export function addonPrefix(barcode: string | null | undefined): string | null {
  const m = /^FC-AD\/([A-Z]+)/.exec((barcode ?? "").trim().toUpperCase());
  return m ? m[1] : null;
}

/** Which kind of add-on this barcode names, or null when we can't say. Null
 *  covers three real cases: the row is the arrangement itself (no `AD/`), the
 *  barcode is missing (16 of 1000 rows), or the prefix is one we haven't seen. */
export function lineItemKindCode(barcode: string | null | undefined): AddonKind | null {
  const prefix = addonPrefix(barcode);
  return prefix ? ADDON_KIND[prefix] ?? null : null;
}

/**
 * A short human label for what this line item is, or null when we can't say.
 *
 * `label` resolves the kind to words; it defaults to English so every existing
 * caller (and every test) keeps its behaviour.
 */
export function lineItemKind(
  barcode: string | null | undefined,
  label: (kind: AddonKind) => string = (k) => EN_KIND_LABEL[k]
): string | null {
  const code = lineItemKindCode(barcode);
  return code ? label(code) : null;
}

/** "Greeting card · I Love You", or just the title when the kind is unknown. */
export function describeLineItem(
  title: string | null,
  barcode: string | null | undefined,
  label: (kind: AddonKind) => string = (k) => EN_KIND_LABEL[k]
): string {
  const name = (title ?? "").trim();
  const kind = lineItemKind(barcode, label);
  if (!kind) return name;
  if (!name) return kind;
  // Don't repeat ourselves when the title already says what it is.
  if (name.toLowerCase().includes(kind.toLowerCase())) return name;
  return `${kind} · ${name}`;
}
