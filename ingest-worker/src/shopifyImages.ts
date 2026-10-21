// Mirrors dashboard/lib/shopifyImages.ts — kept in lockstep, same reasoning:
// Shopify's REST Order resource never carries a line item's image, recipe,
// components/add-ons, or the customer-facing "Includes" blurb (see shopify.ts's
// own header comment). One GraphQL round trip per variant backfills all of it:
// image, barcode (a plain variant field), and this store's `custom.*`
// metafields — recipe, variant_text, variant_icon (a file reference, resolved
// to a MediaImage URL), and components/addons (list.product_reference
// metafields, resolved to the referenced products' titles).

const API_VERSION = "2024-07"; // keep in step with shopify.ts

export interface VariantDetails {
  imageUrl: string | null;
  barcode: string | null;
  recipe: string | null;
  variantText: string | null;
  variantIconUrl: string | null;
  components: string | null; // referenced product titles, comma-joined
  addons: string | null;
}

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
 * rather than blocking order intake over a product-data lookup. */
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
    const json = (await res.json().catch(() => null)) as { data?: { nodes?: (VariantNode | null)[] } } | null;
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
    // best-effort — order intake must never fail over a product-data lookup
  }
  return map;
}
