// The pure half of ingest-on-empty: which area an order names, and whether a
// `queue_ingest` payload that has round-tripped through JSONB is usable.
// Run with: node --test lib/autoIngest.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { deliveryArea, parseIngestRequest } from "./ingestArea.ts";

test("deliveryArea: takes the address's OWN city, not a nearby covered one", () => {
  // Real case (order #2000017): Aix-les-Bains, with our nearest florist 52km
  // away in Grenoble. Scraping "Grenoble" again would find nothing new and skip
  // as already-ingested — the whole point is to scrape where the order goes.
  const addr = { city: "Aix-les-Bains", country: "FR", postal: "73100", line1: "1 Rue Exemple" };
  assert.deepEqual(deliveryArea(addr, 20), { country: "FR", city: "Aix-les-Bains", radiusKm: 20, region: null });
});

test("deliveryArea: the radius passed in is what gets scraped", () => {
  // Callers pass the MATCHING cap: scraping narrower than we match would leave
  // a ring of addresses ingested-nothing/matched-nothing.
  assert.equal(deliveryArea({ city: "Chambéry", country: "FR" }, 50).radiusKm, 50);
});

test("deliveryArea: trims whitespace", () => {
  assert.deepEqual(deliveryArea({ city: "  Athens \n", country: " GR " }, 20), {
    country: "GR", city: "Athens", radiusKm: 20, region: null,
  });
});

test("deliveryArea: includes region when the address carries one (San Carlos/Balears disambiguation)", () => {
  // Order #2000031: San Carlos, Balears — same city name exists in Castilla y
  // León ~900km away. Without the region hint, "Scrape this area" geocoded the
  // wrong one and cached it forever.
  const addr = { city: "San Carlos", country: "ES", region: "Balears" };
  assert.deepEqual(deliveryArea(addr, 20), { country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears" });
});

test("deliveryArea: trims region and treats blank as no hint", () => {
  assert.equal(deliveryArea({ city: "Lyon", country: "FR", region: "  " }, 20).region, null);
  assert.equal(deliveryArea({ city: "Lyon", country: "FR", region: "  Rhône  " }, 20).region, "Rhône");
});

test("deliveryArea: a non-string region is not coerced into one", () => {
  assert.equal(deliveryArea({ city: "Lyon", country: "FR", region: 12345 }, 20).region, null);
});

test("deliveryArea: no city or no country means there is nothing to scrape", () => {
  assert.equal(deliveryArea({ country: "FR" }, 20), null);
  assert.equal(deliveryArea({ city: "Lyon" }, 20), null);
  assert.equal(deliveryArea({ city: "   ", country: "FR" }, 20), null);
  assert.equal(deliveryArea({ city: "Lyon", country: "" }, 20), null);
  assert.equal(deliveryArea(null, 20), null);
  assert.equal(deliveryArea(undefined, 20), null);
  assert.equal(deliveryArea("not an object", 20), null);
});

test("deliveryArea: a non-string city is not coerced into one", () => {
  // Shopify has sent surprising shapes before; "[object Object]" must never
  // become a scrape target.
  assert.equal(deliveryArea({ city: { name: "Lyon" }, country: "FR" }, 20), null);
  assert.equal(deliveryArea({ city: 12345, country: "FR" }, 20), null);
});

test("parseIngestRequest: accepts a well-formed payload", () => {
  assert.deepEqual(parseIngestRequest({ country: "FR", city: "Aix-les-Bains", radiusKm: 20 }), {
    country: "FR", city: "Aix-les-Bains", radiusKm: 20, region: null, nearLat: null, nearLng: null,
  });
});

test("parseIngestRequest: carries region/nearLat/nearLng through a JSONB round trip", () => {
  assert.deepEqual(
    parseIngestRequest({ country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears", nearLat: 39.033, nearLng: 1.564 }),
    { country: "ES", city: "San Carlos", radiusKm: 20, region: "Balears", nearLat: 39.033, nearLng: 1.564 }
  );
});

test("parseIngestRequest: a payload written before region/nearLat/nearLng existed still parses", () => {
  const parsed = parseIngestRequest({ country: "FR", city: "Lyon", radiusKm: 20 });
  assert.equal(parsed.region, null);
  assert.equal(parsed.nearLat, null);
  assert.equal(parsed.nearLng, null);
});

test("parseIngestRequest: rejects anything unusable rather than half-applying it", () => {
  // This payload is written by the worker and read back by the approval
  // executor, so it has crossed a JSONB round trip and a deploy boundary.
  assert.equal(parseIngestRequest(null), null);
  assert.equal(parseIngestRequest({}), null);
  assert.equal(parseIngestRequest({ country: "FR", city: "Lyon" }), null, "no radius");
  assert.equal(parseIngestRequest({ country: "FR", city: "Lyon", radiusKm: 0 }), null, "zero radius");
  assert.equal(parseIngestRequest({ country: "FR", city: "Lyon", radiusKm: -5 }), null, "negative radius");
  assert.equal(parseIngestRequest({ country: "FR", city: "", radiusKm: 20 }), null, "blank city");
  assert.equal(parseIngestRequest({ country: "FR", city: "Lyon", radiusKm: "wide" }), null, "non-numeric radius");
});

test("parseIngestRequest: a numeric radius arriving as a string still parses", () => {
  // JSONB round-trips and form posts both do this.
  assert.deepEqual(parseIngestRequest({ country: "GR", city: "Athens", radiusKm: "20" }), {
    country: "GR", city: "Athens", radiusKm: 20, region: null, nearLat: null, nearLng: null,
  });
});
