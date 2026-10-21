import { describe, expect, it } from "vitest";
import { replaceLineItems } from "../src/db";
import type { LineItemInsert } from "../src/shopify";
import type { SupabaseClient } from "@supabase/supabase-js";

// Regression guard for the line-item photo wipe (2026-08-04): refreshFromShopify
// re-parses the REST webhook payload, where parseShopifyOrder hard-codes
// image_url (and the other variant-lookup columns) to null. Since orders/updated
// fires on ANY mutation, every such webhook used to overwrite the enriched row
// with nulls — losing the photo the florist works from. replaceLineItems must
// carry those columns forward.

const item = (over: Partial<LineItemInsert> = {}): LineItemInsert => ({
  title: "Classic Love - 12 Red Roses", variant: "Large", sku: "FC108-large", catalog_id: null,
  variant_id: null,
  quantity: 1, unit_price: 44.9, line_total: 44.9,
  product_type: null, bouquet_spec: null, image_url: null, personalization: null,
  barcode: null, components: null, addons: null, variant_text: null, variant_icon_url: null,
  ...over,
});

/** Minimal stand-in for the supabase client's chained query builder. */
function fakeClient(stored: Array<Record<string, unknown>>) {
  const inserted: Array<Record<string, unknown>[]> = [];
  let deleted = false;
  const client = {
    from() {
      return {
        select() {
          return { eq: async () => ({ data: stored }) };
        },
        delete() {
          return { eq: async () => { deleted = true; return { error: null }; } };
        },
        insert(rows: Record<string, unknown>[]) {
          inserted.push(rows);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, inserted, wasDeleted: () => deleted };
}

describe("replaceLineItems", () => {
  it("carries the enriched columns forward when the incoming payload has nulls", async () => {
    const { client, inserted } = fakeClient([
      {
        sku: "FC108-large", title: "Classic Love - 12 Red Roses", variant: "Large",
        image_url: "https://cdn.shopify.com/FC108.png", barcode: "BC-1",
        bouquet_spec: "12 red roses", variant_text: "Large bouquet",
        variant_icon_url: "https://cdn.shopify.com/icon.png",
        components: "Vase", addons: "Chocolate",
      },
    ]);

    await replaceLineItems(client, "order-1", [item()]);

    const row = inserted[0][0];
    expect(row.image_url).toBe("https://cdn.shopify.com/FC108.png");
    expect(row.barcode).toBe("BC-1");
    expect(row.bouquet_spec).toBe("12 red roses");
    expect(row.variant_text).toBe("Large bouquet");
    expect(row.variant_icon_url).toBe("https://cdn.shopify.com/icon.png");
    expect(row.components).toBe("Vase");
    expect(row.addons).toBe("Chocolate");
    expect(row.order_id).toBe("order-1");
  });

  it("lets a caller that DID run the variant lookup win over the stored value", async () => {
    const { client, inserted } = fakeClient([
      { sku: "FC108-large", title: "x", variant: null, image_url: "https://cdn.shopify.com/old.png" },
    ]);

    await replaceLineItems(client, "order-1", [item({ image_url: "https://cdn.shopify.com/fresh.png" })]);

    expect(inserted[0][0].image_url).toBe("https://cdn.shopify.com/fresh.png");
  });

  it("matches on title+variant when the line item has no sku", async () => {
    const { client, inserted } = fakeClient([
      { sku: null, title: "I Love You", variant: "Card", image_url: "https://cdn.shopify.com/card.png" },
    ]);

    await replaceLineItems(client, "order-1", [item({ sku: null, title: "I Love You", variant: "Card" })]);

    expect(inserted[0][0].image_url).toBe("https://cdn.shopify.com/card.png");
  });

  it("leaves a genuinely new line item's columns null rather than borrowing another's", async () => {
    const { client, inserted } = fakeClient([
      { sku: "FC108-large", title: "Classic Love", variant: "Large", image_url: "https://cdn.shopify.com/FC108.png" },
    ]);

    await replaceLineItems(client, "order-1", [item({ sku: "FC999-small", title: "Something Else", variant: "Small" })]);

    expect(inserted[0][0].image_url).toBeNull();
  });

  it("is a no-op when nothing changed — no delete, no insert, ids stay stable", async () => {
    // What an orders/updated webhook looks like: same payload, already stored and
    // already enriched. Measured ~14 of these per order, so the no-op matters.
    const storedRow = {
      title: "Classic Love - 12 Red Roses", variant: "Large", sku: "FC108-large", catalog_id: null,
      quantity: 1, unit_price: 44.9, line_total: 44.9,
      product_type: null, personalization: null,
      image_url: "https://cdn.shopify.com/FC108.png", barcode: null, bouquet_spec: null,
      variant_text: null, variant_icon_url: null, components: null, addons: null,
    };
    const { client, inserted, wasDeleted } = fakeClient([storedRow]);

    await replaceLineItems(client, "order-1", [item()]); // incoming image_url null → preserved → identical

    expect(wasDeleted()).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("still rewrites when a real field changed (quantity)", async () => {
    const storedRow = {
      title: "Classic Love - 12 Red Roses", variant: "Large", sku: "FC108-large", catalog_id: null,
      quantity: 1, unit_price: 44.9, line_total: 44.9,
      product_type: null, personalization: null,
      image_url: "https://cdn.shopify.com/FC108.png", barcode: null, bouquet_spec: null,
      variant_text: null, variant_icon_url: null, components: null, addons: null,
    };
    const { client, inserted, wasDeleted } = fakeClient([storedRow]);

    await replaceLineItems(client, "order-1", [item({ quantity: 2 })]);

    expect(wasDeleted()).toBe(true);
    expect(inserted[0][0].quantity).toBe(2);
    expect(inserted[0][0].image_url).toBe("https://cdn.shopify.com/FC108.png"); // still preserved
  });

  it("rewrites when an item was removed from the order", async () => {
    const base = {
      catalog_id: null, quantity: 1, unit_price: 44.9, line_total: 44.9, product_type: null,
      personalization: null, image_url: null, barcode: null, bouquet_spec: null,
      variant_text: null, variant_icon_url: null, components: null, addons: null,
    };
    const { client, wasDeleted } = fakeClient([
      { ...base, title: "A", variant: null, sku: "SKU-A" },
      { ...base, title: "B", variant: null, sku: "SKU-B" },
    ]);

    await replaceLineItems(client, "order-1", [item({ title: "A", variant: null, sku: "SKU-A" })]);

    expect(wasDeleted()).toBe(true);
  });

  it("still deletes and writes nothing when the order has no line items", async () => {
    const { client, inserted, wasDeleted } = fakeClient([{ sku: "FC108-large", title: "x", variant: null, image_url: "u" }]);

    await replaceLineItems(client, "order-1", []);

    expect(wasDeleted()).toBe(true);
    expect(inserted).toHaveLength(0);
  });
});
