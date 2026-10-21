import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceHash, numberTokens, contentLines, listEntries, checkContent,
  buildContentPrompt, parseContentReply,
} from "./content.ts";

// Every fixture below is real production data, pulled from the store on
// 2026-08-06 while measuring what Shopify actually holds. The bad ones are not
// hypothetical failure modes — they are what Translate & Adapt currently serves.

const RECIPE_EN = "12 Freedom rose 50cm\n2 White limonium\n3 Eucalyptus cinerea\n4 Lentiscu\n2 ruscus";

test("the hash is stable, and ignores whitespace noise but not wording", () => {
  assert.equal(sourceHash("12 Freedom rose 50cm"), sourceHash("12 Freedom rose 50cm"));
  assert.equal(sourceHash("  12 Freedom  rose 50cm "), sourceHash("12 Freedom rose 50cm"));
  assert.notEqual(sourceHash("12 Freedom rose 50cm"), sourceHash("15 Freedom rose 50cm"));
});

test("the hash separates strings a weak 32-bit hash could confuse", () => {
  const seen = new Set();
  for (const s of [RECIPE_EN, "White Vase", "white vase", "Chocolates Lindt Box", "2 ruscus", "2 Ruscus"]) {
    seen.add(sourceHash(s));
  }
  assert.equal(seen.size, 6, "case and content must all key differently");
});

test("number tokens are a sorted multiset, so re-ordering a line is not a change", () => {
  assert.deepEqual(numberTokens("12 rose 50cm"), ["12", "50"]);
  assert.deepEqual(numberTokens("50cm rose x12"), ["12", "50"]);
  assert.deepEqual(numberTokens("no numbers here"), []);
});

test("lines and list entries drop the empties Shopify pads its fields with", () => {
  assert.deepEqual(contentLines("a\n\n b \n"), ["a", "b"]);
  assert.deepEqual(listEntries("Vase, Chocolates ,"), ["Vase", "Chocolates"]);
});

// --- checkContent: the cases that motivated the guard ------------------------

test("a good translation passes", () => {
  const es = "12 Rosas Freedom de 50 cm\n2 Limonio blanco\n3 Eucalipto cinerea\n4 Lentisco\n2 Ruscus";
  assert.deepEqual(checkContent("recipe", RECIPE_EN, es), []);
});

// THE MOTIVATING CASE. Shopify metafield 58967797760328, locale es,
// outdated=true: the English source says 12 roses and includes a Lindt box and
// a vase; the Spanish says 15 and drops both. Served as-is, a florist in Spain
// builds the wrong bouquet and forgets two items the customer paid for.
test("a stale Shopify translation with a changed stem count is rejected", () => {
  const en = "12 Freedom rose 50cm\n2 White limonium\n4 Eucalyptus cinerea\n5 Lentiscu\n3 ruscus\nChocolates Lindt Box\nWhite Vase";
  const staleEs = "15 Rosa de la libertad 50cm\n2 Limonio blanco\n4 Eucalipto cinéreo\n5 Lenticua\n3 Ruscus";
  const reasons = checkContent("recipe", en, staleEs);
  assert.ok(reasons.some((r) => r.includes("Numbers changed")), reasons.join(" | "));
  assert.ok(reasons.some((r) => r.includes("ingredient lines")), reasons.join(" | "));
  assert.ok(reasons.some((r) => r.includes("Freedom")), reasons.join(" | "));
});

// Measured: mangled in 10/21 fr, 14/21 de, 11/21 it, 18/27 pt-BR.
test("a mistranslated cultivar name is rejected in every locale that does it", () => {
  for (const bad of [
    "12 Roses de la liberté 50 cm\n2 Limonium blanc\n3 Eucalyptus cinerea\n4 Lentisque\n2 Ruscus",
    "12 Freiheit Rose 50cm\n2 Weiße Limonium\n3 Eukalyptus cinerea\n4 Lentiscu\n2 Ruscus",
    "12 Rose della Libertà 50cm\n2 Limonium bianco\n3 Eucalipto cinerea\n4 Lentisco\n2 Ruscus",
    "12 Róż wolności 50 cm\n2 Biały limonium\n3 Eukaliptus cinerea\n4 Lentiscu\n2 Ruscus",
  ]) {
    const reasons = checkContent("recipe", RECIPE_EN, bad);
    assert.ok(reasons.some((r) => r.includes('Lost "Freedom"')), `should reject: ${bad.split("\n")[0]}`);
  }
});

test("botanical Latin is free to localise — that is not a mangled name", () => {
  const es = "12 Rosas Freedom de 50 cm\n2 Limonio blanco\n3 Eucalipto cinerea\n4 Lentisco\n2 Ruscus";
  assert.deepEqual(checkContent("recipe", RECIPE_EN, es), [], "Limonium→Limonio must not trip the guard");
});

test("a dropped ingredient line is rejected even when the numbers happen to match", () => {
  const short = "12 Rosas Freedom de 50 cm\n2 Limonio blanco\n3 Eucalipto cinerea\n4 Lentisco 2 Ruscus";
  const reasons = checkContent("recipe", RECIPE_EN, short);
  assert.ok(reasons.some((r) => r.includes("ingredient lines")), reasons.join(" | "));
});

test("a dropped entry in components/addons is rejected", () => {
  const reasons = checkContent("addons", "White Vase, Chocolates Lindt Box, Teddy Bear", "Jarrón blanco, Osito de peluche");
  assert.ok(reasons.some((r) => r.includes("2 entries") || r.includes("3 entries")), reasons.join(" | "));
});

test("a brand name lost from an add-on list is rejected", () => {
  const reasons = checkContent("addons", "Chocolates Lindt Box", "Caja de bombones");
  assert.ok(reasons.some((r) => r.includes('Lost "Lindt"')), reasons.join(" | "));
});

test("titles are checked too — a number in a product name is part of the product", () => {
  assert.deepEqual(checkContent("title", "Classic Love - 12 Red Roses", "Amor Clásico - 12 Rosas Rojas"), []);
  const reasons = checkContent("title", "Classic Love - 12 Red Roses", "Amor Clásico - 24 Rosas Rojas");
  assert.ok(reasons.some((r) => r.includes("Numbers changed")), reasons.join(" | "));
});

// Reported from production on assignment 55bab232: the offer read "Endless
// Passion - 30 Red Roses · Best Value - Deluxe" to a French florist, with the
// variant left in English in the middle of an otherwise translated line.
test("the variant name translates, and is not held to list or line structure", () => {
  assert.deepEqual(checkContent("variant", "Best Value - Deluxe", "De luxe"), []);
  assert.deepEqual(checkContent("variant", "Classic", "Classique"), []);
  // Commas and newlines carry no meaning in a variant name, so a comma
  // appearing or vanishing must not reject it the way it would for an add-on
  // list.
  assert.deepEqual(checkContent("variant", "Best Value, Deluxe", "De luxe"), []);
});

test("a variant name that changes a number is still rejected", () => {
  const reasons = checkContent("variant", "Bundle of 3", "Lot de 5");
  assert.ok(reasons.some((r) => r.includes("Numbers changed")), reasons.join(" | "));
});

test("empty is rejected on its own, without piling on every other complaint", () => {
  assert.deepEqual(checkContent("recipe", RECIPE_EN, "   "), ["Empty translation."]);
});

test("an em dash is rejected, matching the rest of our outbound copy", () => {
  const reasons = checkContent("title", "Classic Love", "Amor Clásico — Rosas");
  assert.ok(reasons.some((r) => r.includes("em dash")), reasons.join(" | "));
});

// --- prompt + reply ----------------------------------------------------------

test("the prompt names the language, carries every source, and states the cultivar rule", () => {
  const p = buildContentPrompt(
    [
      { id: "h1", field: "recipe", source: RECIPE_EN },
      { id: "h2", field: "title", source: "Classic Love - 12 Red Roses" },
    ],
    "fr"
  );
  assert.ok(p.includes("French"));
  assert.ok(p.includes("h1") && p.includes("h2"));
  assert.ok(p.includes(RECIPE_EN));
  assert.ok(/Freedom/.test(p), "the cultivar rule must name the case we measured");
});

test("an unknown locale falls back to its code rather than throwing", () => {
  assert.ok(buildContentPrompt([{ id: "h1", field: "title", source: "Rose" }], "nl").includes("nl"));
});

test("the reply parser tolerates a code fence and ignores ids it wasn't asked about", () => {
  const got = parseContentReply('```json\n{"h1": "Amor", "h9": "nope"}\n```', ["h1", "h2"]);
  assert.equal(got.get("h1"), "Amor");
  assert.equal(got.has("h9"), false);
  assert.equal(got.has("h2"), false);
});

test("an unreadable reply yields nothing rather than a guess", () => {
  assert.equal(parseContentReply("sorry, I can't do that", ["h1"]).size, 0);
  assert.equal(parseContentReply('{"h1": 12}', ["h1"]).size, 0);
});
