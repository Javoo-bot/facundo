import test from "node:test";
import assert from "node:assert/strict";
import { splitOfferItems, hasRecipe, itemValue } from "./offerItems.ts";

// Fixtures mirror real production shapes: a card is a cheap row with no recipe,
// a bouquet is an expensive row that usually carries one. NOTE none of them set
// product_type — the module deliberately ignores it, because 988 of 1000
// production rows say "bouquet" including the cards and the teddy bear.
const item = (id, { spec = null, total = null, unit = null } = {}) => ({
  id,
  bouquet_spec: spec,
  line_total: total,
  unit_price: unit,
});
const card = (id, price = 5.9) => item(id, { total: price });
const bouquet = (id, price = 66.9) => item(id, { spec: "12 x rose", total: price });

const ids = (xs) => xs.map((x) => x.id);

test("a single item is the hero with nothing beside it", () => {
  const { hero, alsoInclude } = splitOfferItems([bouquet("b1")]);
  assert.equal(hero.id, "b1");
  assert.deepEqual(ids(alsoInclude), []);
});

// THE MOTIVATING CASE — production order #2000018 arrives in exactly this
// order: a teddy bear, a greeting card, then the roses. All three are typed
// "bouquet", so type cannot break the tie; the recipe and the price can.
test("the real bouquet heroes even when it is the LAST row and everything is typed the same", () => {
  const teddy = item("sandy", { total: 12.9 });
  const greetingCard = card("iloveyou");
  const roses = bouquet("roses", 62);
  const { hero, alsoInclude } = splitOfferItems([teddy, greetingCard, roses]);
  assert.equal(hero.id, "roses");
  assert.deepEqual(ids(alsoInclude), ["sandy", "iloveyou"]); // priciest add-on first
});

test("the item carrying a recipe outranks a pricier item without one", () => {
  // Guards the rule ORDER: recipe is consulted before price, so an expensive
  // add-on can never displace the arrangement the florist has to make.
  const priceyAddon = item("hamper", { total: 120 });
  const roses = bouquet("roses", 62);
  const { hero, alsoInclude } = splitOfferItems([priceyAddon, roses]);
  assert.equal(hero.id, "roses");
  assert.deepEqual(ids(alsoInclude), ["hamper"]);
});

test("with no recipe anywhere, the priciest item heroes", () => {
  // 120 of 191 multi-item production orders have no recipe on any row.
  const { hero, alsoInclude } = splitOfferItems([card("c1"), item("mid", { total: 40 }), card("c2", 7.9)]);
  assert.equal(hero.id, "mid");
  assert.deepEqual(ids(alsoInclude), ["c2", "c1"]);
});

test("two recipes: the priciest arrangement heroes, the other leads the rest", () => {
  const { hero, alsoInclude } = splitOfferItems([card("c1"), bouquet("small", 45), bouquet("big", 84.9)]);
  assert.equal(hero.id, "big");
  assert.deepEqual(ids(alsoInclude), ["small", "c1"]);
});

test("unit_price stands in when line_total is missing", () => {
  const { hero } = splitOfferItems([card("c1"), item("b1", { unit: 70 })]);
  assert.equal(hero.id, "b1");
  assert.equal(itemValue({ bouquet_spec: null, line_total: null, unit_price: 70 }), 70);
});

test("an unpriced row never outranks a priced one", () => {
  const { hero, alsoInclude } = splitOfferItems([item("unpriced"), card("c1")]);
  assert.equal(hero.id, "c1");
  assert.deepEqual(ids(alsoInclude), ["unpriced"]);
});

test("ties resolve to the earliest row, so the order never reshuffles", () => {
  const a = card("a");
  const b = card("b");
  for (let i = 0; i < 5; i++) {
    const { hero, alsoInclude } = splitOfferItems([a, b]);
    assert.equal(hero.id, "a");
    assert.deepEqual(ids(alsoInclude), ["b"]);
  }
});

test("an empty order yields no hero and nothing to include", () => {
  assert.deepEqual(splitOfferItems([]), { hero: null, alsoInclude: [] });
});

test("hasRecipe treats blank and whitespace-only specs as absent", () => {
  assert.ok(hasRecipe({ bouquet_spec: "12 x rose" }));
  assert.ok(!hasRecipe({ bouquet_spec: "   " }));
  assert.ok(!hasRecipe({ bouquet_spec: null }));
});

// Every item must survive the split exactly once — nothing silently dropped
// from an order the florist is being paid to deliver.
test("the split is lossless for any arrangement of items", () => {
  const cases = [
    [bouquet("b1"), card("c1"), item("x", { total: 9 })],
    [card("c1"), card("c2")],
    [bouquet("b1"), bouquet("b2", 50), bouquet("b3", 70)],
    [item("nulls")],
  ];
  for (const items of cases) {
    const { hero, alsoInclude } = splitOfferItems(items);
    const out = [hero, ...alsoInclude].filter(Boolean);
    assert.equal(out.length, items.length, JSON.stringify(ids(items)));
    assert.deepEqual([...ids(out)].sort(), [...ids(items)].sort());
  }
});
