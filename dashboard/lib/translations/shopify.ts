// Reading Shopify's OWN translations (Translate & Adapt) for the two things a
// florist works from: the product title and the `custom.recipe` metafield.
//
// Needs the `read_translations` scope on the Admin token — added 2026-08-06 via
// dashboard/scripts/shopify-reauth.sh. Without it every call here 403s, which
// this module treats like any other failure: empty maps, and the caller falls
// through to the model-drafted path.
//
// Two round trips, not one, because a metafield's translations are keyed by the
// METAFIELD's own id and there is no way to ask for them through the variant.
// So: variants → metafield ids, then ids → translations.
//
// `outdated` is REPORTED, not acted on here. Shopify sets it when the English
// source changed after the translation was written, and what that's worth
// depends entirely on the field — which is the caller's business, not this
// module's. Measured on one product: the Deluxe recipe is outdated in all five
// locales and genuinely wrong (15 roses against the source's 12, with the Lindt
// box, vase, teddy and card all dropped), while the fr/de/pt-BR product TITLES
// are outdated and completely fine. lib/translations/lineItems.ts decides.

const API_VERSION = "2024-07"; // keep in step with lib/shopifyImages.ts

/** Our locale codes are not always Shopify's. The store publishes pt-BR (there
 *  is no plain `pt`), so a florist we hold as `pt` reads the Brazilian catalog —
 *  the same call the rest of the product makes (see lib/i18n/locales.ts, where
 *  BR and PT both resolve to one `pt`). The others match 1:1. */
const SHOPIFY_LOCALE: Record<string, string> = {
  es: "es", fr: "fr", it: "it", de: "de", pt: "pt-BR",
};

export function shopifyLocale(locale: string): string | null {
  return SHOPIFY_LOCALE[locale] ?? null;
}

/** A translation as Shopify holds it. `outdated` means the English source has
 *  changed since this was written — see the header for why that is the caller's
 *  call to make. */
export interface ShopifyTranslation {
  value: string;
  outdated: boolean;
}

export interface ShopifyTranslations {
  /** shopify product id (numeric string) → translated title */
  titles: Map<string, ShopifyTranslation>;
  /** shopify variant id (numeric string) → translated recipe */
  recipes: Map<string, ShopifyTranslation>;
  /** shopify product id → { English option-value name → translation }.
   *  Keyed by the ENGLISH NAME rather than by variant id on purpose: the
   *  variant name is a PRODUCT_OPTION_VALUE hanging off the product, so this
   *  resolves from `catalog_id` alone and therefore works on the rows imported
   *  before we started storing `variant_id`. */
  variants: Map<string, Map<string, ShopifyTranslation>>;
}

const empty = (): ShopifyTranslations => ({ titles: new Map(), recipes: new Map(), variants: new Map() });

/** The two response shapes this module asks for. Everything is optional: a
 *  partial GraphQL response (some nodes null, a field absent) is normal, and
 *  each read below is guarded rather than assumed. */
type OptionValue = { id?: string; name?: string };
type VariantMetafieldNode =
  | { id?: string; recipe?: { id?: string } | null; options?: { optionValues?: OptionValue[] | null }[] | null }
  | null;
type TranslationNode = { key?: string; value?: string | null; outdated?: boolean };
type TranslatableNode = { resourceId?: string; translations?: TranslationNode[] | null } | null;
interface GraphqlResponse {
  data?: {
    nodes?: VariantMetafieldNode[];
    translatableResourcesByIds?: { nodes?: TranslatableNode[] } | null;
  } | null;
}

async function graphql(
  shop: string, token: string, query: string, variables: Record<string, unknown>, timeoutMs: number
): Promise<GraphqlResponse | null> {
  try {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // timeout, network, malformed JSON — caller falls back
  }
}

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * Translations for these products/variants in this locale. Best-effort in every
 * direction: an unsupported locale, a missing credential, a 403 from a token
 * without `read_translations`, or a timeout all return whatever was gathered so
 * far (often nothing). Never throws.
 */
export async function fetchShopifyTranslations(args: {
  shop: string;
  token: string;
  locale: string;
  productIds: string[];
  variantIds: string[];
  timeoutMs?: number;
}): Promise<ShopifyTranslations> {
  const { shop, token, locale, timeoutMs = 5_000 } = args;
  const loc = shopifyLocale(locale);
  if (!shop || !token || !loc) return empty();

  const productIds = [...new Set(args.productIds.filter(Boolean))];
  const variantIds = [...new Set(args.variantIds.filter(Boolean))];
  if (!productIds.length && !variantIds.length) return empty();

  const out = empty();

  // 1. Resolve the ids that aren't the product/variant ids themselves:
  //    a variant's recipe METAFIELD, and a product's OPTION VALUES (which is
  //    what a variant name like "Best Value - Deluxe" actually is). One call
  //    for both — `nodes` is polymorphic, so products and variants ride
  //    together.
  const metafieldToVariant = new Map<string, string>();       // metafield gid → variant id
  const optionValueToProduct = new Map<string, { productId: string; name: string }>();
  const idsToResolve = [
    ...variantIds.map((id) => `gid://shopify/ProductVariant/${id}`),
    ...productIds.map((id) => `gid://shopify/Product/${id}`),
  ];
  for (const batch of chunk(idsToResolve, 50)) {
    const json = await graphql(shop, token, `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant { id recipe: metafield(namespace: "custom", key: "recipe") { id } }
          ... on Product { id options { optionValues { id name } } }
        }
      }`, { ids: batch }, timeoutMs);
    for (const node of json?.data?.nodes ?? []) {
      const gid = node?.id ?? "";
      const numeric = gid.split("/").pop() ?? "";
      const mid = node?.recipe?.id;
      if (mid) metafieldToVariant.set(mid, numeric);
      for (const option of node?.options ?? []) {
        for (const value of option?.optionValues ?? []) {
          if (value?.id && value?.name) {
            optionValueToProduct.set(value.id, { productId: numeric, name: value.name });
          }
        }
      }
    }
  }

  // 2. Everything's translations in one sweep. A product answers under `title`,
  //    a metafield under `value`, an option value under `name` — same query,
  //    different key.
  const resourceIds = [
    ...productIds.map((id) => `gid://shopify/Product/${id}`),
    ...metafieldToVariant.keys(),
    ...optionValueToProduct.keys(),
  ];
  for (const batch of chunk(resourceIds, 50)) {
    const json = await graphql(shop, token, `
      query($ids: [ID!]!, $loc: String!) {
        translatableResourcesByIds(first: 50, resourceIds: $ids) {
          nodes { resourceId translations(locale: $loc) { key value outdated } }
        }
      }`, { ids: batch, loc }, timeoutMs);
    for (const node of json?.data?.translatableResourcesByIds?.nodes ?? []) {
      const rid = node?.resourceId ?? "";
      const usable = (key: string): ShopifyTranslation | null => {
        const t = (node?.translations ?? []).find((x) => x?.key === key);
        if (!t || typeof t.value !== "string" || !t.value.trim()) return null;
        return { value: t.value, outdated: !!t.outdated };
      };
      if (rid.includes("/Product/")) {
        const v = usable("title");
        if (v) out.titles.set(rid.split("/").pop() ?? "", v);
      } else if (metafieldToVariant.has(rid)) {
        const v = usable("value");
        if (v) out.recipes.set(metafieldToVariant.get(rid)!, v);
      } else if (optionValueToProduct.has(rid)) {
        const v = usable("name");
        const { productId, name } = optionValueToProduct.get(rid)!;
        if (v) {
          const byName = out.variants.get(productId) ?? new Map<string, ShopifyTranslation>();
          byName.set(name, v);
          out.variants.set(productId, byName);
        }
      }
    }
  }

  return out;
}
