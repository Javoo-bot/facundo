// Sanity assertions for the florist-number reserved-range helper. Run with:
//   node --test lib/floristNumber.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { FLORIST_NUMBER_RESERVED_START, isReservedFloristNumber } from "./floristNumber.ts";

test("the reserved range starts at 9,000,000 — well above a plausible legacy Odoo id", () => {
  assert.equal(FLORIST_NUMBER_RESERVED_START, 9000000);
  assert.ok(FLORIST_NUMBER_RESERVED_START > 1562030, "must stay above Odoo's own example id shape");
});

test("a value at or above the reserved start is reserved", () => {
  assert.equal(isReservedFloristNumber(9000000), true);
  assert.equal(isReservedFloristNumber(9000001), true);
  assert.equal(isReservedFloristNumber(9999999), true);
});

test("a value below the reserved start (a legacy id shape) is not reserved", () => {
  assert.equal(isReservedFloristNumber(1562030), false);
  assert.equal(isReservedFloristNumber(0), false);
});

test("non-integers are never reserved", () => {
  assert.equal(isReservedFloristNumber(9000000.5), false);
  assert.equal(isReservedFloristNumber(NaN), false);
});
