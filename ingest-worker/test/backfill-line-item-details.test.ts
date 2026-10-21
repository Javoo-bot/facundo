import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs operator script, no types (same as the other script tests)
import { resolveVariantIds, buildPatch } from "../scripts/backfill-line-item-details.mjs";

// Pure logic of the repair script — the part worth testing without a live
// Shopify/Supabase. Getting the variant match wrong would write ANOTHER line
// item's photo onto this one, which is worse than the null it replaces.

describe("resolveVariantIds", () => {
  it("matches on sku regardless of line-item order", () => {
    const stored = [
      { id: "li-1", title: "Roses", variant: "Large", sku: "FC108-large" },
      { id: "li-2", title: "Card", variant: null, sku: "CARD-1" },
    ];
    const raw = [
      { variant_id: 222, title: "Card", variant_title: null, sku: "CARD-1" },
      { variant_id: 111, title: "Roses", variant_title: "Large", sku: "FC108-large" },
    ];
    expect(resolveVariantIds(stored, raw)).toEqual([
      { id: "li-1", variantId: "111" },
      { id: "li-2", variantId: "222" },
    ]);
  });

  it("falls back to title+variant when the line item has no sku", () => {
    const stored = [{ id: "li-1", title: "I Love You", variant: "Card", sku: null }];
    const raw = [{ variant_id: 999, title: "I Love You", variant_title: "Card", sku: null }];
    expect(resolveVariantIds(stored, raw)).toEqual([{ id: "li-1", variantId: "999" }]);
  });

  it("falls back to position when neither sku nor title matches", () => {
    const stored = [{ id: "li-1", title: "Renamed since", variant: null, sku: null }];
    const raw = [{ variant_id: 777, title: "Original name", variant_title: null, sku: null }];
    expect(resolveVariantIds(stored, raw)).toEqual([{ id: "li-1", variantId: "777" }]);
  });

  it("yields null rather than guessing when the raw payload has no variant_id", () => {
    const stored = [{ id: "li-1", title: "Roses", variant: null, sku: "X" }];
    expect(resolveVariantIds(stored, [{ title: "Roses", sku: "X" }])).toEqual([{ id: "li-1", variantId: null }]);
    expect(resolveVariantIds(stored, [])).toEqual([{ id: "li-1", variantId: null }]);
  });
});

describe("buildPatch", () => {
  const details = {
    image_url: "https://cdn/img.png", barcode: "BC", bouquet_spec: "12 roses",
    variant_text: "Large", variant_icon_url: "https://cdn/icon.png",
    components: "Vase", addons: "Chocolate",
  };

  it("fills every column that is currently null", () => {
    const item = {
      image_url: null, barcode: null, bouquet_spec: null, variant_text: null,
      variant_icon_url: null, components: null, addons: null,
    };
    expect(buildPatch(item, details)).toEqual(details);
  });

  it("never overwrites a value that survived the wipe", () => {
    const item = {
      image_url: "https://cdn/kept.png", barcode: null, bouquet_spec: null,
      variant_text: null, variant_icon_url: null, components: null, addons: null,
    };
    const patch = buildPatch(item, details);
    expect(patch.image_url).toBeUndefined();
    expect(patch.barcode).toBe("BC");
  });

  it("returns null when there is nothing to do (idempotent re-run)", () => {
    expect(buildPatch({ ...details }, details)).toBeNull();
    expect(buildPatch({ image_url: null }, null)).toBeNull();
  });

  it("does not invent a value Shopify itself does not have", () => {
    const item = { image_url: null, barcode: null };
    expect(buildPatch(item, { image_url: null, barcode: "BC" })).toEqual({ barcode: "BC" });
  });
});
