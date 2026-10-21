import test from "node:test";
import assert from "node:assert/strict";
import { resolveFloristSendLocale } from "./floristLocale.ts";

const CRANVES_SALES = "831 Rte de l'Exemple, 74380 Cranves-Sales, Frankreich";
const GENEVA = "Rue de l'Exemple 16, 1205 Genève, Schweiz";
const ZURICH = "Bahnhofstrasse 1, 8001 Zürich, Schweiz";

test("a stored locale always wins, over both address and city", () => {
  assert.equal(resolveFloristSendLocale({ locale: "it", address: CRANVES_SALES }, "CH"), "it");
  // Including an explicit "en" — a florist who asked for English keeps it.
  assert.equal(resolveFloristSendLocale({ locale: "en", address: GENEVA }, "CH"), "en");
});

test("the shop's own address beats the city it was ingested under", () => {
  // Order #2000034: a French shop inside the Founex (CH) radius. The city says
  // CH, which maps to nothing, which is how this went out in English.
  assert.equal(resolveFloristSendLocale({ locale: null, address: CRANVES_SALES }, "CH"), "fr");
  // Same city, genuinely Swiss, split by postcode.
  assert.equal(resolveFloristSendLocale({ locale: null, address: GENEVA }, "CH"), "fr");
  assert.equal(resolveFloristSendLocale({ locale: null, address: ZURICH }, "CH"), "de");
  // Basel holds shops in three countries; each now answers for itself.
  assert.equal(
    resolveFloristSendLocale({ locale: null, address: "Beispielstraße 32, 79576 Weil am Rhein, Deutschland" }, "CH"),
    "de"
  );
});

test("the Moroccan and Andorran shops now get French and Spanish", () => {
  assert.equal(resolveFloristSendLocale({ locale: null, address: "Village Exemple, Casablanca 27182, Maroc" }, null), "fr");
  assert.equal(resolveFloristSendLocale({ locale: null, address: "Av. Exemple, 41, AD500 Andorra la Vella, Andorra" }, null), "es");
});

test("the city's country still answers when the address cannot", () => {
  // ~5% of rows name no country at all — the old behaviour must survive.
  assert.equal(resolveFloristSendLocale({ locale: null, address: "Carrer del Carme 10, Girona" }, "ES"), "es");
  assert.equal(resolveFloristSendLocale({ locale: null, address: null }, "FR"), "fr");
  // A caller that never selected `address` degrades, it does not break.
  assert.equal(resolveFloristSendLocale({ locale: null }, "AT"), "de");
});

test("falls back to EN without throwing on anything unusable", () => {
  assert.equal(resolveFloristSendLocale(null), "en");
  assert.equal(resolveFloristSendLocale(undefined, null), "en");
  assert.equal(resolveFloristSendLocale({}, null), "en");
  assert.equal(resolveFloristSendLocale({ locale: "not-a-locale" }, null), "en");
  // A Danish shop: country read correctly, no catalog for it, so EN — and
  // that is the right answer, not a gap.
  assert.equal(
    resolveFloristSendLocale({ locale: null, address: "Eksempelvej 48, 2300 København, Danmark" }, "DK"),
    "en"
  );
});
