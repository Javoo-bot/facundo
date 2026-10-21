import { describe, it, expect } from "vitest";
import { countryFromAddress, phoneRegionFor } from "../src/shopCountry";
import { normalizePhone } from "../src/phones";
import { buildRow, buildBareRow } from "../src/db";
import { buildRepairPatch } from "../src/repair";

// A real production row: the florist on order #2000034. French shop, ingested
// under the Swiss city of Founex because it sits inside that city's 20 km
// radius. Enrichment correctly pulled "04 50 00 11 22" off the shop's own site.
const CRANVES_SALES = "831 Rte de l'Exemple, 74380 Cranves-Sales, Frankreich";
const LOCAL_LANDLINE = "04 50 00 11 22";

describe("countryFromAddress", () => {
  it("reads the country in the language Google returned it in", () => {
    expect(countryFromAddress(CRANVES_SALES)).toBe("FR");
    expect(countryFromAddress("Rue de l'Exemple 16, 1205 Genève, Schweiz")).toBe("CH");
    expect(countryFromAddress("Beispielgasse 13, 1030 Wien, Österreich")).toBe("AT");
    expect(countryFromAddress("Eksempelvej 48, 2300 København, Danmark")).toBe("DK");
    expect(countryFromAddress("Παραδείγματος 34, Αθήνα 112 53, Ελλάδα")).toBe("GR");
  });

  it("finds a country that is not the last segment", () => {
    expect(countryFromAddress("Example Ave, 40, Uzhhorod, Zakarpattia Oblast, Ukrajina, 88000")).toBe("UA");
  });

  it("returns null rather than guessing", () => {
    expect(countryFromAddress("Carrer del Carme 10, Girona")).toBeNull();
    expect(countryFromAddress("None, Boston, MA 02122")).toBeNull();
    expect(countryFromAddress(null)).toBeNull();
  });
});

describe("the #2000034 phone regression", () => {
  // This is the bug, pinned. If libphonenumber-js ever starts rejecting this
  // input under CH the first assertion will fail — which is good news, and
  // the test should then be updated, not the fix removed.
  it("libphonenumber-js accepts a French landline as Swiss under the city's region", () => {
    expect(normalizePhone(LOCAL_LANDLINE, "CH")).toBe("+41 45 000 11 22");
  });

  it("the shop's own address gives the right country and the right number", () => {
    expect(phoneRegionFor(CRANVES_SALES, "CH")).toBe("FR");
    expect(normalizePhone(LOCAL_LANDLINE, phoneRegionFor(CRANVES_SALES, "CH"))).toBe("+33 4 50 00 11 22");
  });

  it("falls back to the city's region when the address names no country", () => {
    expect(phoneRegionFor("Carrer del Carme 10, Girona", "ES")).toBe("ES");
    expect(phoneRegionFor(null, "CH")).toBe("CH");
  });
});

describe("row builders use the shop's own region, not the city's", () => {
  const scraped = {
    place_id: "test-place",
    name: "JOUR DE FLEUR'AISON CRANVES SALES FLEURISTE",
    address: CRANVES_SALES,
    phone_maps: LOCAL_LANDLINE,
    phone_web: LOCAL_LANDLINE,
  };

  it("buildRow normalizes both phones against FR even though the city is CH", () => {
    const row = buildRow(scraped as never, "city-founex", "CH");
    expect(row.phone_web).toBe("+33 4 50 00 11 22");
    expect(row.phone_maps).toBe("+33 4 50 00 11 22");
  });

  it("buildBareRow does the same for phone_maps", () => {
    const row = buildBareRow(scraped as never, "city-founex", "CH");
    expect(row.phone_maps).toBe("+33 4 50 00 11 22");
  });

  it("buildRepairPatch normalizes a repaired phone_web against the shop's region", () => {
    const current = { id: "f1", address: CRANVES_SALES, phone_web: null, email: null,
                      owner_name: null, shop_highlight: null, is_ecommerce: null,
                      ecommerce_signals: null, network_id: null, website_url: null };
    const fresh = { phone_web: LOCAL_LANDLINE, enrichment_notes: null };
    const patch = buildRepairPatch(current as never, fresh as never, "CH");
    expect(patch.phone_web).toBe("+33 4 50 00 11 22");
  });
});
