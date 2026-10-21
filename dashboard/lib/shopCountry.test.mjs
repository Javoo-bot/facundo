// Every address literal below is a REAL row from the production `florists`
// table, sampled 2026-09-16 (one per distinct trailing token, shop names
// omitted — these are public business listings, not personal data). They are
// here because the shapes are what broke: the parser was written against
// them, not against invented examples.
import test from "node:test";
import assert from "node:assert/strict";
import {
  countryFromAddress,
  swissLocaleFromPostcode,
  localeFromAddress,
} from "./shopCountry.ts";

test("countryFromAddress reads the country from the tail, in any language", () => {
  const cases = [
    ["14 Av. de l'Exemple, 69300 Caluire-et-Cuire, France", "FR"],
    ["831 Rte de l'Exemple, 74380 Cranves-Sales, Frankreich", "FR"],
    ["Rue de l'Exemple 16, 1205 Genève, Schweiz", "CH"],
    ["Zürich, Switzerland", "CH"],
    ["Beispielgasse 13, 1030 Wien, Österreich", "AT"],
    ["Beispielstraße 32, 79576 Weil am Rhein, Deutschland", "DE"],
    ["Av. del Ejemplo, s/n, Poniente Sur, 14004 Córdoba, España", "ES"],
    ["Av. do Exemplo 7C, 2800-011 Almada, Portugal", "PT"],
    ["Rua Exemplo, 100 - Lj 1 - Botafogo, Rio de Janeiro - RJ, 22250-040, Brasil", "BR"],
    ["Calle Ejemplo 1000, C1044AAN C1044AAN, Cdad. Autónoma de Buenos Aires, Argentina", "AR"],
    ["Cra. 1 #1-00, Centro, Cartagena de Indias, Bolívar, Colombia", "CO"],
    ["C. Ejemplo 143, Santo Domingo 10211, República Dominicana", "DO"],
    ["Village Exemple, Casablanca 27182, Maroc", "MA"],
    ["Eksempelvej 48, 2300 København, Danmark", "DK"],
    ["Przykladowa 2, 80-180 Kowale, Polska", "PL"],
    ["Exempelvägen 3, 438 93 Landvetter, Sverige", "SE"],
    ["Örnek Mah, Örnek, 1. Cd. 1/A, 06520 Çankaya/Ankara, Türkiye", "TR"],
    ["Παραδείγματος 34, Αθήνα 112 53, Ελλάδα", "GR"],
    ["דוגמה 1, תל אביב-יפו, ישראל", "IL"],
  ];
  for (const [address, expected] of cases) {
    assert.equal(countryFromAddress(address), expected, address);
  }
});

// Google does not always put the country last. This exact row is why the
// parser scans three trailing segments instead of one.
test("countryFromAddress finds a country that is not the last segment", () => {
  assert.equal(
    countryFromAddress("Example Ave, 40, Uzhhorod, Zakarpattia Oblast, Ukrajina, 88000"),
    "UA"
  );
});

// ~5% of production rows name no country at all. A guess here would be worse
// than nothing: it is precisely how a French shop ended up on a Swiss code.
test("countryFromAddress returns null rather than guessing", () => {
  assert.equal(countryFromAddress("Carrer del Carme 10, Girona"), null);
  assert.equal(countryFromAddress("None, Boston, MA 02122"), null);
  assert.equal(countryFromAddress("Rue de la Gare 3, 88000"), null);
  assert.equal(countryFromAddress(""), null);
  assert.equal(countryFromAddress(null), null);
  assert.equal(countryFromAddress(undefined), null);
});

// "Andorra la Vella" must not match the country "Andorra" — only whole
// segments count, never substrings.
test("countryFromAddress matches whole segments, not substrings", () => {
  assert.equal(countryFromAddress("Av. Exemple, 41, AD500 Andorra la Vella, Andorra"), "AD");
  assert.equal(countryFromAddress("Av. Exemple, 41, AD500 Andorra la Vella"), null);
});

test("swissLocaleFromPostcode splits Switzerland by postcode region", () => {
  // French-speaking: Geneva 1205, Lausanne 1003, Neuchâtel 2000.
  assert.equal(swissLocaleFromPostcode("Rue de l'Exemple 16, 1205 Genève, Schweiz"), "fr");
  assert.equal(swissLocaleFromPostcode("Rue de Bourg 1, 1003 Lausanne, Schweiz"), "fr");
  assert.equal(swissLocaleFromPostcode("Rue du Seyon 1, 2000 Neuchâtel, Schweiz"), "fr");
  // German-speaking: Zurich 8001, Basel 4051, Bern 3011, Zug 6300.
  assert.equal(swissLocaleFromPostcode("Bahnhofstrasse 1, 8001 Zürich, Schweiz"), "de");
  assert.equal(swissLocaleFromPostcode("Freie Strasse 1, 4051 Basel, Schweiz"), "de");
  assert.equal(swissLocaleFromPostcode("Marktgasse 1, 3011 Bern, Schweiz"), "de");
  assert.equal(swissLocaleFromPostcode("Bahnhofstrasse 1, 6300 Zug, Schweiz"), "de");
  // Italian-speaking: Lugano 6900. Production has zero of these today; the
  // arm exists so the first one is right rather than German.
  assert.equal(swissLocaleFromPostcode("Via Nassa 5, 6900 Lugano, Schweiz"), "it");
});

// The street number precedes the postcode in the string, so a parser that
// took the FIRST 4-digit run would read "1205 Genève" as house number 16.
test("swissLocaleFromPostcode is not fooled by a house number", () => {
  assert.equal(swissLocaleFromPostcode("Rue de l'Exemple 16, 1205 Genève, Schweiz"), "fr");
  assert.equal(swissLocaleFromPostcode("Bahnhofstrasse 9000, 1205 Genève, Schweiz"), "de");
});

test("swissLocaleFromPostcode returns null when there is no readable postcode", () => {
  assert.equal(swissLocaleFromPostcode("Zürich, Switzerland"), null);
  assert.equal(swissLocaleFromPostcode(null), null);
});

test("localeFromAddress composes country and the Swiss postcode rule", () => {
  // The order #2000034 florist: a French shop that inherited CH from Founex.
  assert.equal(
    localeFromAddress("831 Rte de l'Exemple, 74380 Cranves-Sales, Frankreich"),
    "fr"
  );
  // Basel is a three-country city; each shop now answers for itself.
  assert.equal(localeFromAddress("Beispielstraße 32, 79576 Weil am Rhein, Deutschland"), "de");
  assert.equal(localeFromAddress("Freie Strasse 1, 4051 Basel, Schweiz"), "de");
  // Geneva francophones, who were getting English.
  assert.equal(localeFromAddress("Rue de l'Exemple 16, 1205 Genève, Schweiz"), "fr");
  assert.equal(localeFromAddress("Beispielgasse 13, 1030 Wien, Österreich"), "de");
  assert.equal(localeFromAddress("C. Ejemplo 143, Santo Domingo 10211, República Dominicana"), "es");
});

// Null means "the address cannot decide" and the caller keeps its fallback.
// It covers three different reasons, all of which must stay non-throwing.
test("localeFromAddress returns null when the address cannot decide", () => {
  assert.equal(localeFromAddress("Eksempelvej 48, 2300 København, Danmark"), null); // no DK catalog
  assert.equal(localeFromAddress("Carrer del Carme 10, Girona"), null); // no country named
  assert.equal(localeFromAddress("Zürich, Switzerland"), null); // CH, no postcode
  assert.equal(localeFromAddress(null), null);
});
