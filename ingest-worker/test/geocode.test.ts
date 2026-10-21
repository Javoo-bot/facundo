import { afterEach, describe, it, expect, vi } from "vitest";
import { haversineKm, geocodeCityCenter, GeocodeMismatchError, MAX_GEOCODE_DRIFT_KM } from "../src/geocode";

describe("haversineKm", () => {
  it("returns 0 for identical points", () => {
    expect(haversineKm({ lat: 41.3874, lng: 2.1686 }, { lat: 41.3874, lng: 2.1686 })).toBe(0);
  });

  it("computes the great-circle distance between Barcelona and Girona (~85-90km)", () => {
    const barcelona = { lat: 41.3874, lng: 2.1686 };
    const girona = { lat: 41.9794, lng: 2.8214 };
    const distance = haversineKm(barcelona, girona);
    expect(distance).toBeGreaterThan(85);
    expect(distance).toBeLessThan(90);
  });
});

function ok(results: unknown[]): Response {
  return new Response(JSON.stringify(results), { status: 200 });
}

// The real order #2000031 case, distilled: San Carlos exists both in Balears
// (Ibiza) and ~900km away in Castilla y León. The unhinted, single-result path
// picked the wrong one; that's exactly the regression this module now guards.
const SAN_CARLOS_NEAR = { lat: 39.033, lng: 1.564 }; // the order's own delivery point (Balears)
const SAN_CARLOS_CANDIDATES = [
  // #0: top-ranked by Nominatim, but the WRONG San Carlos (Castilla y León, ~900km away).
  { lat: "41.9", lon: "-4.8", address: { state: "Castilla y León" } },
  // A handful of irrelevant filler candidates, as the real limit=8 response would include.
  { lat: "40.1", lon: "-3.7", address: { state: "Madrid" } },
  { lat: "38.0", lon: "-1.2", address: { state: "Murcia" } },
  { lat: "37.5", lon: "-2.0", address: { state: "Andalucía" } },
  { lat: "42.0", lon: "-8.0", address: { state: "Galicia" } },
  // #5: the actually-correct San Carlos (Sant Carles de Peralta, Balears), ~0.8km from near.
  { lat: "39.0378", lon: "1.5589", address: { state: "Illes Balears" } },
  { lat: "36.0", lon: "-5.0", address: { state: "Andalucía" } },
  { lat: "43.0", lon: "-2.0", address: { state: "País Vasco" } },
];

describe("geocodeCityCenter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("without a region hint or near point, keeps today's exact behavior: limit=1, take results[0], no drift check", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([{ lat: "41.9", lon: "-4.8", address: { state: "Castilla y León" } }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeCityCenter("ES", "San Carlos");

    expect(result).toEqual({ lat: 41.9, lng: -4.8, region: "Castilla y León" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("limit=1");
    expect(url).toContain(encodeURIComponent("San Carlos, ES"));
  });

  it("appends the region hint to the query when given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([{ lat: "39.0378", lon: "1.5589", address: { state: "Illes Balears" } }]));
    vi.stubGlobal("fetch", fetchMock);

    await geocodeCityCenter("ES", "San Carlos", "Balears");

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("San Carlos, Balears, ES"));
  });

  it("with a near point, requests limit=8 and picks the candidate closest to near, not the top-ranked one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(SAN_CARLOS_CANDIDATES));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeCityCenter("ES", "San Carlos", "Balears", SAN_CARLOS_NEAR);

    expect(result.region).toBe("Illes Balears");
    expect(result.lat).toBeCloseTo(39.0378, 3);
    expect(result.lng).toBeCloseTo(1.5589, 3);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("limit=8");
  });

  it("throws GeocodeMismatchError when even the closest candidate exceeds MAX_GEOCODE_DRIFT_KM and reverse fallback fails", async () => {
    // Only the wrong, ~900km-away San Carlos comes back — no plausible candidate at all.
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.includes("/reverse")
        ? new Response(JSON.stringify({ error: "Unable to geocode" }), { status: 200 })
        : ok([{ lat: "41.9", lon: "-4.8", address: { state: "Castilla y León" } }])
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeCityCenter("ES", "San Carlos", "Balears", SAN_CARLOS_NEAR)).rejects.toThrow(
      GeocodeMismatchError
    );
  });

  it("falls back to reverse geocode when forward candidates exist but are all too far from the order point", async () => {
    // Real #2000035 shape: Shopify gave city/country as "Trèves, FR", but the
    // delivery coordinate is Trier, Germany. Forward search finds French Trèves;
    // the near point's reverse geocode is the trustworthy location.
    const TRIER_NEAR = { lat: 49.7388749, lng: 6.6966993 };
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.includes("/reverse")
        ? new Response(JSON.stringify({
            lat: "49.7370928",
            lon: "6.6868475",
            address: { city: "Trier", state: "Rheinland-Pfalz", country_code: "de" },
          }), { status: 200 })
        : ok([{ lat: "45.5398029", lon: "4.6756420", address: { state: "Auvergne-Rhône-Alpes" } }])
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeCityCenter("FR", "Trèves", null, TRIER_NEAR);

    expect(result).toEqual({ lat: 49.7370928, lng: 6.6868475, region: "Rheinland-Pfalz" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0] as string).toContain("/reverse");
  });

  it("MAX_GEOCODE_DRIFT_KM is 150", () => {
    expect(MAX_GEOCODE_DRIFT_KM).toBe(150);
  });

  it("still throws the plain not-found error when Nominatim returns nothing and there's no near point to reverse-geocode from", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ok([])));
    await expect(geocodeCityCenter("ES", "Nowhereville")).rejects.toThrow(/could not geocode/);
  });

  // The real 2026-09-04 case: a Shopify order's own delivery address geocoded
  // fine (that's `near`), but its `city` string reached the ingest mangled
  // ("SAINT BARTHOLOMY" — missing the accent AND misspelled, vs the real
  // "Saint-Barthélemy"), so the forward free-text search matched nothing.
  function ok1(result: unknown): Response {
    return new Response(JSON.stringify(result), { status: 200 });
  }
  const SAINT_BARTHELEMY_NEAR = { lat: 46.6342834, lng: 6.5942567 };
  const SAINT_BARTHELEMY_REVERSE = {
    lat: "46.6351600",
    lon: "6.5921502",
    address: { village: "Saint-Barthélemy (VD)", state: "Vaud", country_code: "ch" },
  };

  it("falls back to a reverse geocode off `near` when the forward search returns nothing", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.includes("/reverse") ? ok1(SAINT_BARTHELEMY_REVERSE) : ok([])
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeCityCenter("CH", "SAINT BARTHOLOMY", null, SAINT_BARTHELEMY_NEAR);

    expect(result).toEqual({ lat: 46.63516, lng: 6.5921502, region: "Vaud" });
    const reverseUrl = fetchMock.mock.calls.find((c) => (c[0] as string).includes("/reverse"))![0] as string;
    expect(reverseUrl).toContain(`lat=${SAINT_BARTHELEMY_NEAR.lat}`);
    expect(reverseUrl).toContain(`lon=${SAINT_BARTHELEMY_NEAR.lng}`);
  });

  it("still throws the plain not-found error when both the forward search AND the reverse fallback come up empty", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.includes("/reverse") ? ok1({ error: "Unable to geocode" }) : ok([])
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeCityCenter("ES", "Nowhereville", "Nowhere", SAN_CARLOS_NEAR)).rejects.toThrow(
      /could not geocode/
    );
  });

  it("does not attempt a reverse geocode when there's no near point, even on empty results", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeCityCenter("ES", "Nowhereville")).rejects.toThrow(/could not geocode/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
