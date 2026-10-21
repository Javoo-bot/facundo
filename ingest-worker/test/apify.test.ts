import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIFY_LANGUAGE_OVERRIDES,
  extractMapsOnlineOrder,
  normalizeItems,
  startApifyRun,
  type ApifyPlaceItem,
} from "../src/apify";

describe("APIFY_LANGUAGE_OVERRIDES", () => {
  // The actor's input schema rejects ISO 639-1 "he" (only accepts the old
  // Google Maps code "iw") — this is what silently 400'd every IL
  // (Jerusalem, Kfar Saba) ingest run until the override was added. KEEP IN
  // STEP with ingest/scrape.py::APIFY_LANGUAGE_OVERRIDES.
  it("maps Hebrew to the actor's legacy language code", () => {
    expect(APIFY_LANGUAGE_OVERRIDES.he).toBe("iw");
  });
});

describe("startApifyRun", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the actor's legacy 'iw' code, not 'he', when language is Hebrew", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "run1", defaultDatasetId: "ds1", status: "READY" } }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await startApifyRun({
      token: "tok",
      centerLat: 31.78,
      centerLng: 35.22,
      radiusKm: 10,
      limit: 20,
      keywords: ["פרחים"],
      language: "he",
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse((requestInit as RequestInit).body as string);
    expect(sentBody.language).toBe("iw");
  });

  it("passes an unmapped language straight through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "run1", defaultDatasetId: "ds1", status: "READY" } }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await startApifyRun({
      token: "tok",
      centerLat: 41.4,
      centerLng: 2.2,
      radiusKm: 10,
      limit: 20,
      keywords: ["florista"],
      language: "es",
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse((requestInit as RequestInit).body as string);
    expect(sentBody.language).toBe("es");
  });
});

describe("extractMapsOnlineOrder", () => {
  it("returns true when a truthy label matches an online-order keyword (case-insensitive)", () => {
    const item: ApifyPlaceItem = {
      additionalInfo: {
        "Service options": [{ "Online estimates": true }, { "Onsite services": true }],
      },
    };
    expect(extractMapsOnlineOrder(item)).toBe(true);
  });

  it("matches regardless of label casing", () => {
    const item: ApifyPlaceItem = {
      additionalInfo: {
        "Service options": [{ "ONLINE ORDERING": true }],
      },
    };
    expect(extractMapsOnlineOrder(item)).toBe(true);
  });

  it("ignores a matching label whose value is falsy", () => {
    const item: ApifyPlaceItem = {
      additionalInfo: {
        "Service options": [{ "Online ordering": false }],
      },
    };
    expect(extractMapsOnlineOrder(item)).toBeNull();
  });

  it("returns null (not false) when there is no matching label", () => {
    const item: ApifyPlaceItem = {
      additionalInfo: {
        "Service options": [{ "Onsite services": true }],
      },
    };
    expect(extractMapsOnlineOrder(item)).toBeNull();
  });

  it("returns null when additionalInfo is absent", () => {
    const item: ApifyPlaceItem = {};
    expect(extractMapsOnlineOrder(item)).toBeNull();
  });
});

describe("normalizeItems", () => {
  const baseItem: ApifyPlaceItem = {
    placeId: "abc123",
    title: "Test Florist",
    address: "123 Main St",
    location: { lat: 40.1, lng: -73.9 },
    totalScore: 4.5,
    reviewsCount: 12,
    phone: "+1 555-000-1111",
    website: "https://example.com",
    additionalInfo: {
      "Service options": [{ "Online ordering": true }],
    },
  };

  it("normalizes an item into a ScrapedFlorist with all fields mapped", () => {
    const result = normalizeItems([baseItem]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      place_id: "abc123",
      name: "Test Florist",
      address: "123 Main St",
      lat: 40.1,
      lng: -73.9,
      rating: 4.5,
      review_count: 12,
      phone_maps: "+1 555-000-1111",
      website_url: "https://example.com",
      category_name: null,
      categories: null,
      maps_online_order: true,
    });
  });

  it("maps missing fields to null", () => {
    const sparse: ApifyPlaceItem = { placeId: "sparse-1" };
    const result = normalizeItems([sparse]);
    expect(result[0]).toEqual({
      place_id: "sparse-1",
      name: null,
      address: null,
      lat: null,
      lng: null,
      rating: null,
      review_count: null,
      phone_maps: null,
      website_url: null,
      category_name: null,
      categories: null,
      maps_online_order: null,
    });
  });

  it("drops items with no placeId", () => {
    const noId: ApifyPlaceItem = { title: "No ID Florist" };
    const result = normalizeItems([noId, baseItem]);
    expect(result).toHaveLength(1);
    expect(result[0].place_id).toBe("abc123");
  });

  it("dedups by placeId, keeping the first occurrence", () => {
    const duplicate: ApifyPlaceItem = { ...baseItem, title: "Duplicate Florist" };
    const result = normalizeItems([baseItem, duplicate]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Test Florist");
  });
});
