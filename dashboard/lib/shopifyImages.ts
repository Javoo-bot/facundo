// Real product/variant data a florist needs that Shopify's REST Order resource
// never carries (line items only have title/sku/price/qty — see
// shopifyParse.ts's own header comment): image, barcode, and the `custom.*`
// metafields this store's product data actually uses (confirmed against the
// real store) — recipe, variant_text, variant_icon (a file reference,
// resolved to a MediaImage URL), and components/addons (list.product_reference
// metafields, resolved to the referenced products' titles). One GraphQL round
// trip per import covers all of it. Kept as its own module (network call) so
// shopifyParse.ts stays a pure function.

const API_VERSION = "2024-07"; // keep in step with shopifyParse.ts / shopifyWriteback.ts

export interface VariantDetails {
  imageUrl: string | null;
  barcode: string | null;
  recipe: string | null;
  variantText: string | null;
  variantIconUrl: string | null;
  components: string | null; // referenced product titles, comma-joined
  addons: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL response
type VariantNode = {
  id: string;
  barcode?: string | null;
  image?: { url: string } | null;
  product?: { featuredImage?: { url: string } | null } | null;
  recipe?: { value: string } | null;
  variantText?: { value: string } | null;
  variantIcon?: { reference?: { image?: { url: string } | null } | null } | null;
  components?: { references?: { nodes?: { title?: string }[] } | null } | null;
  addons?: { references?: { nodes?: { title?: string }[] } | null } | null;
};

const titles = (ref: { references?: { nodes?: { title?: string }[] } | null } | null | undefined): string | null => {
  const names = (ref?.references?.nodes ?? []).map((n) => n.title).filter((t): t is string => !!t);
  return names.length ? names.join(", ") : null;
};

/** Maps Shopify numeric variant ids (as strings, matching line_items[].variant_id)
 * to their resolved details. Best-effort: returns an empty map on any failure
 * rather than blocking the order import over a product-data lookup. */
export async function fetchVariantDetails(shop: string, token: string, variantIds: string[]): Promise<Map<string, VariantDetails>> {
  const map = new Map<string, VariantDetails>();
  const ids = [...new Set(variantIds.filter(Boolean))];
  if (!ids.length) return map;

  const query = `
    query VariantDetails($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          barcode
          image { url }
          product { featuredImage { url } }
          recipe: metafield(namespace: "custom", key: "recipe") { value }
          variantText: metafield(namespace: "custom", key: "variant_text") { value }
          variantIcon: metafield(namespace: "custom", key: "variant_icon") {
            reference { ... on MediaImage { image { url } } }
          }
          components: metafield(namespace: "custom", key: "components") {
            references(first: 20) { nodes { ... on Product { title } } }
          }
          addons: metafield(namespace: "custom", key: "addons") {
            references(first: 20) { nodes { ... on Product { title } } }
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { ids: ids.map((id) => `gid://shopify/ProductVariant/${id}`) } }),
    });
    if (!res.ok) return map;
    const json = await res.json().catch(() => null) as { data?: { nodes?: (VariantNode | null)[] } } | null;
    for (const node of json?.data?.nodes ?? []) {
      if (!node) continue;
      map.set(node.id.split("/").pop() ?? "", {
        imageUrl: node.image?.url ?? node.product?.featuredImage?.url ?? null,
        barcode: node.barcode ?? null,
        recipe: node.recipe?.value ?? null,
        variantText: node.variantText?.value ?? null,
        variantIconUrl: node.variantIcon?.reference?.image?.url ?? null,
        components: titles(node.components),
        addons: titles(node.addons),
      });
    }
  } catch {
    // best-effort — an order import must never fail over a product-data lookup
  }
  return map;
}
