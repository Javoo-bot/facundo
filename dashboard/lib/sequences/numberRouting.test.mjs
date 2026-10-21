import test from "node:test";
import assert from "node:assert/strict";
import { resolveNumberForCity, canCallFlorist } from "./numberRouting.ts";

const n = (over = {}) => ({
  id: "n1", e164: "+34931234567", country: "ES",
  city_id: null, persona_id: null, status: "assigned", ...over,
});

const GIRONA = "city-girona";
const MADRID = "city-madrid";

test("the city's own number wins", () => {
  const nums = [n({ id: "es-spare" }), n({ id: "girona", city_id: GIRONA }), n({ id: "madrid", city_id: MADRID })];
  assert.equal(resolveNumberForCity(GIRONA, "ES", nums)?.id, "girona");
});

// Still a local dialling code, still cheaper and more answerable than an
// international one.
test("falls back to a spare number in the same country", () => {
  const nums = [n({ id: "es-spare" }), n({ id: "madrid", city_id: MADRID })];
  assert.equal(resolveNumberForCity(GIRONA, "ES", nums)?.id, "es-spare");
});

// Borrowing another city's line is more surprising to that city's florists than
// using a number nobody has been given yet.
test("a spare is preferred over another city's number", () => {
  const nums = [n({ id: "madrid", city_id: MADRID }), n({ id: "es-spare" })];
  assert.equal(resolveNumberForCity(GIRONA, "ES", nums)?.id, "es-spare");
});

test("another city's number is used only as a last resort", () => {
  const nums = [n({ id: "madrid", city_id: MADRID })];
  assert.equal(resolveNumberForCity(GIRONA, "ES", nums)?.id, "madrid");
});

// The rule that matters most: no "use whatever we have" tier. A Spanish florist
// seeing a German number reads as a scam, and that impression cannot be undone.
test("we never call from another country's number", () => {
  const nums = [n({ id: "de", country: "DE" }), n({ id: "fr", country: "FR" })];
  assert.equal(resolveNumberForCity(GIRONA, "ES", nums), null);
});

test("no usable number means do not call, not call anyway", () => {
  assert.equal(resolveNumberForCity(GIRONA, "ES", []), null);
  assert.equal(resolveNumberForCity(null, null, [n()]), null);
});

test("only assigned numbers are usable", () => {
  for (const status of ["available", "releasing", "released", ""]) {
    assert.equal(resolveNumberForCity(GIRONA, "ES", [n({ city_id: GIRONA, status })]), null, status);
  }
});

test("country matching ignores case and padding", () => {
  assert.equal(resolveNumberForCity(null, " es ", [n({ id: "es-spare" })])?.id, "es-spare");
  assert.equal(resolveNumberForCity(null, "Es", [n({ id: "es-spare" })])?.id, "es-spare");
});

// ---- may we call at all ----

test("a florist with a number and no opt-out is callable", () => {
  assert.equal(canCallFlorist({ phone_e164: "+34600111222" }), true);
});

// Reading a text opt-out as permission to phone them is not a reading anyone
// would defend out loud.
test("an SMS opt-out blocks calls too", () => {
  assert.equal(canCallFlorist({ phone_e164: "+34600111222", order_sms_opt_out: true }), false);
});

test("no number, excluded or deleted means no call", () => {
  assert.equal(canCallFlorist({ phone_e164: null }), false);
  assert.equal(canCallFlorist({ phone_e164: "", }), false);
  assert.equal(canCallFlorist({ phone_e164: "+34600111222", excluded_at: "2026-01-01" }), false);
  assert.equal(canCallFlorist({ phone_e164: "+34600111222", deleted_at: "2026-01-01" }), false);
});
