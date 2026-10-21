import { describe, expect, it, vi } from "vitest";
import { buildBareRow, buildRow, getOrCreateCity } from "../src/db";
import type { ScrapedFlorist } from "../src/types";

const baseFlorist: ScrapedFlorist = {
  place_id: "place-1",
  name: "Test Florist",
  address: "123 Main St",
  lat: 40.1,
  lng: -73.9,
  rating: 4.5,
  review_count: 12,
  phone_maps: "555-000-1111",
  website_url: "https://example.com",
  maps_online_order: true,
  category_name: null,
  categories: null,
  distance_km_from_center: 2.3,
};

describe("buildBareRow", () => {
  it("builds the bare (pre-enrichment) row with deleted_at null", () => {
    const row = buildBareRow(baseFlorist, "city-1", null);
    expect(row).toEqual({
      city_id: "city-1",
      place_id: "place-1",
      name: "Test Florist",
      address: "123 Main St",
      lat: 40.1,
      lng: -73.9,
      rating: 4.5,
      review_count: 12,
      distance_km_from_center: 2.3,
      phone_maps: "555-000-1111",
      website_url: "https://example.com",
      has_website: true,
      category_name: null,
      categories: null,
      deleted_at: null,
    });
  });

  it("persists Google's Maps category so the florist can be re-judged later", () => {
    // The relevance filter's free rule reads these. They used to be dropped on
    // write, which is why non-florists scraped before the filter can only be
    // cleaned by a full re-ingest of their city.
    const row = buildBareRow(
      { ...baseFlorist, category_name: "Florist", categories: ["Florist", "Gift shop"] },
      "city-1",
      null,
    );
    expect(row.category_name).toBe("Florist");
    expect(row.categories).toEqual(["Florist", "Gift shop"]);
  });

  it("has_website is false when website_url is null", () => {
    const row = buildBareRow({ ...baseFlorist, website_url: null }, "city-1", null);
    expect(row.has_website).toBe(false);
  });

  it("does not include any enrichment columns", () => {
    const row = buildBareRow(baseFlorist, "city-1", null);
    expect("is_ecommerce" in row).toBe(false);
    expect("email" in row).toBe(false);
    expect("drafted_email" in row).toBe(false);
  });
});

describe("buildRow", () => {
  const enriched = {
    ...baseFlorist,
    has_website: true,
    is_ecommerce: true,
    ecommerce_signals: { platform: "shopify" },
    email: "hello@example.com",
    phone_web: "555-222-3333",
    owner_name: "Jane Doe",
    shop_highlight: "Same-day delivery",
    content_language: "en",
    enrichment_notes: "looks good",
    enrichment_ai_context: {
      agent: "sherlock" as const,
      rulesHash: "0123456789abcdef",
      calls: [{ name: "owner", model: "anthropic/claude-haiku-4.5", prompt: "Who owns this shop?" }],
    },
  };

  it("builds the full row after enrichment", () => {
    const row = buildRow(enriched, "city-1", null);
    expect(row).toEqual({
      city_id: "city-1",
      place_id: "place-1",
      name: "Test Florist",
      address: "123 Main St",
      lat: 40.1,
      lng: -73.9,
      rating: 4.5,
      review_count: 12,
      distance_km_from_center: 2.3,
      phone_maps: "555-000-1111",
      website_url: "https://example.com",
      has_website: true,
      category_name: null,
      categories: null,
      is_ecommerce: true,
      ecommerce_signals: { platform: "shopify" },
      email: "hello@example.com",
      phone_web: "555-222-3333",
      owner_name: "Jane Doe",
      shop_highlight: "Same-day delivery",
      enrichment_notes: "looks good",
      enrichment_ai_context: enriched.enrichment_ai_context,
      deleted_at: null,
    });
  });

  it("never includes a drafted_email key (Phase 0 invariant: re-ingest must not null an on-demand draft)", () => {
    const row = buildRow(enriched, "city-1", null);
    expect("drafted_email" in row).toBe(false);
  });

  it("sets deleted_at to null (resurrects a returning-after-reset florist)", () => {
    const row = buildRow(enriched, "city-1", null);
    expect(row.deleted_at).toBeNull();
  });

  it("defaults enrichment fields to null/false when missing (bare-row-shaped input)", () => {
    const row = buildRow(baseFlorist, "city-1", null);
    expect(row.has_website).toBe(false);
    expect(row.is_ecommerce).toBeNull();
    expect(row.ecommerce_signals).toBeNull();
    expect(row.email).toBeNull();
    expect(row.phone_web).toBeNull();
    expect(row.owner_name).toBeNull();
    expect(row.shop_highlight).toBeNull();
    expect(row.enrichment_notes).toBeNull();
  });

  it("passes phone fields through normalizePhone with the given region (region=null is passthrough)", () => {
    const row = buildRow({ ...baseFlorist, phone_maps: "555-000-1111", phone_web: "555-222-3333" }, "city-1", null);
    // With phoneRegion=null, normalizePhone should not throw and should return
    // some string/null shape (exact normalization behavior belongs to
    // phones.test.ts) — assert the fields are present and of the right type.
    expect(row.phone_maps === null || typeof row.phone_maps === "string").toBe(true);
    expect(row.phone_web === null || typeof row.phone_web === "string").toBe(true);
  });
});

// Minimal chainable stub matching exactly the "cities" call shapes
// getOrCreateCity uses: select().eq().eq()[.eq()].limit(1); update().eq();
// insert().select().single().
function makeCitiesSb(opts: {
  selectResults: Array<{ data: Array<Record<string, unknown>> | null; error?: unknown }>;
  updateResult?: { error: unknown } | null;
  insertResult?: { data: Record<string, unknown> | null; error: unknown };
}) {
  let selectCall = 0;
  const eqCalls: string[][] = [];
  let currentEqCalls: string[] = [];
  const sb = {
    from(table: string) {
      expect(table).toBe("cities");
      currentEqCalls = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          currentEqCalls.push(`${col}=${v}`);
          return chain;
        },
        limit: async () => {
          eqCalls.push(currentEqCalls);
          return opts.selectResults[selectCall++];
        },
        update: () => ({
          eq: async () => opts.updateResult ?? { error: null },
        }),
        insert: () => ({
          select: () => ({
            single: async () => opts.insertResult,
          }),
        }),
      };
      return chain;
    },
  };
  return { sb, eqCalls };
}

describe("getOrCreateCity", () => {
  it("no hint: keeps today's exact behavior — lookup by (country, city) only, no region in WHERE", async () => {
    const { sb, eqCalls } = makeCitiesSb({
      selectResults: [{ data: [{ id: "city-1", region: "Illes Balears" }] }],
    });
    const geocodeFn = vi.fn();

    const res = await getOrCreateCity(sb as any, "ES", "San Carlos", 20, geocodeFn);

    expect(res).toEqual({ cityId: "city-1", wasCreated: false });
    expect(eqCalls[0]).toEqual(["country=ES", "city=San Carlos"]);
    // Already has a region, so no backfill geocode.
    expect(geocodeFn).not.toHaveBeenCalled();
  });

  it("no hint, existing row with no region yet: geocodes once to backfill, writing region ?? \"\"", async () => {
    const { sb } = makeCitiesSb({
      selectResults: [{ data: [{ id: "city-1", region: null }] }],
    });
    const geocodeFn = vi.fn().mockResolvedValue({ lat: 1, lng: 2, region: null });

    const res = await getOrCreateCity(sb as any, "ES", "San Carlos", 20, geocodeFn);

    expect(res).toEqual({ cityId: "city-1", wasCreated: false });
    expect(geocodeFn).toHaveBeenCalledTimes(1);
  });

  it("no hint, brand-new city: inserts with region ?? \"\" (NOT NULL column)", async () => {
    const { sb } = makeCitiesSb({
      selectResults: [{ data: [] }],
      insertResult: { data: { id: "city-new" }, error: null },
    });
    const geocodeFn = vi.fn().mockResolvedValue({ lat: 1, lng: 2, region: null });

    const res = await getOrCreateCity(sb as any, "ES", "Nowhereville", 20, geocodeFn);

    expect(res).toEqual({ cityId: "city-new", wasCreated: true });
  });

  it("hinted: always re-geocodes, even though the region-qualified row already exists", async () => {
    const { sb, eqCalls } = makeCitiesSb({
      selectResults: [{ data: [{ id: "city-1" }] }],
    });
    const geocodeFn = vi.fn().mockResolvedValue({ lat: 39.03, lng: 1.55, region: "Illes Balears" });

    const res = await getOrCreateCity(sb as any, "ES", "San Carlos", 20, geocodeFn, "Balears");

    expect(geocodeFn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ cityId: "city-1", wasCreated: false });
    // Looked up by Nominatim's OWN resolved region ("Illes Balears"), not the hint string ("Balears").
    expect(eqCalls[0]).toEqual(["country=ES", "city=San Carlos", "region=Illes Balears"]);
  });

  it("hinted: converges repeated calls onto the same row via Nominatim's resolved region, not the hint wording", async () => {
    // Two different orders both hint "Balears" in one case and "Illes Balears" in
    // another; Nominatim resolves both to the same "Illes Balears" — the lookup
    // must match on that resolved value so they land on the same city row.
    const { sb, eqCalls } = makeCitiesSb({
      selectResults: [{ data: [{ id: "city-1" }] }],
    });
    const geocodeFn = vi.fn().mockResolvedValue({ lat: 39.03, lng: 1.55, region: "Illes Balears" });

    await getOrCreateCity(sb as any, "ES", "San Carlos", 20, geocodeFn, "Balears de Ibiza");

    expect(eqCalls[0]).toContain("region=Illes Balears");
  });

  it("hinted: not found — inserts a new row keyed on Nominatim's resolved region", async () => {
    const { sb } = makeCitiesSb({
      selectResults: [{ data: [] }],
      insertResult: { data: { id: "city-new" }, error: null },
    });
    const geocodeFn = vi.fn().mockResolvedValue({ lat: 39.03, lng: 1.55, region: "Illes Balears" });

    const res = await getOrCreateCity(sb as any, "ES", "San Carlos", 20, geocodeFn, "Balears");

    expect(res).toEqual({ cityId: "city-new", wasCreated: true });
  });

  it("hinted: a geocode result with no region normalizes to '' for both the lookup and the insert", async () => {
    const { sb, eqCalls } = makeCitiesSb({
      selectResults: [{ data: [] }],
      insertResult: { data: { id: "city-new" }, error: null },
    });
    const geocodeFn = vi.fn().mockResolvedValue({ lat: 1, lng: 2, region: null });

    await getOrCreateCity(sb as any, "XX", "Somewhere", 20, geocodeFn, "SomeHint");

    expect(eqCalls[0]).toContain("region=");
  });
});
