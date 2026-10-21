import test from "node:test";
import assert from "node:assert/strict";
import { hasSufficientFunds } from "./funds.ts";

const bal = [
  { currency: "EUR", available_amount: 100 },
  { currency: "GBP", available_amount: 5 },
];

test("sufficient funds -> ok", () => {
  assert.deepEqual(hasSufficientFunds(bal, "EUR", 5000), { ok: true, available: 100 }); // need 50
});

test("exact balance -> ok (>=)", () => {
  assert.deepEqual(hasSufficientFunds(bal, "EUR", 10000), { ok: true, available: 100 });
});

test("insufficient -> not ok (fail-closed on known-insufficient)", () => {
  assert.deepEqual(hasSufficientFunds(bal, "GBP", 5000), { ok: false, available: 5 }); // need 50, have 5
});

test("unknown currency -> fail-open (ok, available null)", () => {
  assert.deepEqual(hasSufficientFunds(bal, "USD", 5000), { ok: true, available: null });
});

test("null / empty balances -> fail-open", () => {
  assert.deepEqual(hasSufficientFunds(null, "EUR", 5000), { ok: true, available: null });
  assert.deepEqual(hasSufficientFunds([], "EUR", 5000), { ok: true, available: null });
});

test("null available_amount -> fail-open", () => {
  assert.deepEqual(hasSufficientFunds([{ currency: "EUR", available_amount: null }], "EUR", 100), { ok: true, available: null });
});

test("currency match is case-insensitive", () => {
  assert.equal(hasSufficientFunds([{ currency: "eur", available_amount: 100 }], "EUR", 5000).ok, true);
});
