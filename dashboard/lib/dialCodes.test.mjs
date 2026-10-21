import test from "node:test";
import assert from "node:assert/strict";
import { dialCountries, splitPhone, joinPhone } from "./dialCodes.ts";

test("the list is populated, named, sorted, and carries dial codes", () => {
  const list = dialCountries();
  assert.ok(list.length > 200, `expected a full country list, got ${list.length}`);
  const es = list.find((c) => c.code === "ES");
  assert.deepEqual({ code: es.code, dial: es.dial, name: es.name }, { code: "ES", dial: "34", name: "Spain" });
  const names = list.map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en")));
});

test("every entry has a real name and a flag — no bare codes a florist can't read", () => {
  for (const c of dialCountries()) {
    assert.ok(c.name && c.name !== c.code, `unnamed entry: ${c.code}`);
    assert.equal([...c.flag].length, 2, `bad flag for ${c.code}`);
  }
});

test("splits an international number into country and national part", () => {
  assert.deepEqual(splitPhone("+34612345678", null), { code: "ES", national: "612345678" });
});

test("tolerates punctuation in a stored number", () => {
  assert.deepEqual(splitPhone("(+34) 612-34.56.78", null), { code: "ES", national: "612345678" });
});

test("a shared dial code cannot be resolved from the number alone, and we don't pretend otherwise", () => {
  // libphonenumber reports the plain country calling code, so every NANP
  // country is "1" — +1868 is Trinidad, but nothing in the digits says so.
  // What must hold: the national part is correct, and the country is SOME
  // country on +1 rather than a wrong guess dressed up as certain.
  const got = splitPhone("+18686231234", null);
  assert.equal(got.national, "8686231234");
  const picked = dialCountries().find((c) => c.code === got.code);
  assert.equal(picked.dial, "1");
});

test("a shared dial code resolves to the florist's own country", () => {
  // +1 belongs to the US and ~20 others; the florist's region breaks the tie.
  assert.equal(splitPhone("+12125550123", "US").code, "US");
  assert.equal(splitPhone("+12125550123", "CA").code, "CA");
});

test("a national number keeps the florist's country and the digits as typed", () => {
  assert.deepEqual(splitPhone("612 34 56 78", "ES"), { code: "ES", national: "612 34 56 78" });
});

test("an empty value yields the florist's country and nothing typed", () => {
  assert.deepEqual(splitPhone("", "ES"), { code: "ES", national: "" });
  assert.deepEqual(splitPhone(null, "FR"), { code: "FR", national: "" });
});

test("an unknown fallback region is dropped rather than shown as a bogus country", () => {
  assert.deepEqual(splitPhone(null, "ZZ"), { code: "", national: "" });
  assert.deepEqual(splitPhone(null, null), { code: "", national: "" });
});

test("a + value matching no dial code keeps the whole string visible", () => {
  const got = splitPhone("+9999999999999", "ES");
  assert.equal(got.national, "+9999999999999");
});

test("joins the two controls back into E.164", () => {
  assert.equal(joinPhone("34", "612345678"), "+34612345678");
  assert.equal(joinPhone("34", "612 34 56 78"), "+34612345678");
});

test("an empty national part submits nothing, not a bare dial code", () => {
  assert.equal(joinPhone("34", ""), "");
  assert.equal(joinPhone("34", "   "), "");
});

test("a pasted full international number is left alone", () => {
  assert.equal(joinPhone("34", "+33612345678"), "+33612345678");
});

test("round-trips through split and join", () => {
  const { code, national } = splitPhone("+34612345678", "ES");
  const dial = dialCountries().find((c) => c.code === code).dial;
  assert.equal(joinPhone(dial, national), "+34612345678");
});
