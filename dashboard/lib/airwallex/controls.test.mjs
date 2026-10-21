import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthorizationControls, centsToMajor, parseMccAllowlist } from "./controls.ts";

test("centsToMajor rounds to 2dp, no float tail", () => {
  assert.equal(centsToMajor(2660), 26.6);
  assert.equal(centsToMajor(9999), 99.99);
  assert.equal(centsToMajor(1), 0.01);
  assert.equal(centsToMajor(0), 0);
});

test("parseMccAllowlist splits on comma/space and trims", () => {
  assert.deepEqual(parseMccAllowlist("5992, 5193 , 5947"), ["5992", "5193", "5947"]);
  assert.deepEqual(parseMccAllowlist("5992"), ["5992"]);
  assert.deepEqual(parseMccAllowlist(""), []);
  assert.deepEqual(parseMccAllowlist(undefined), []);
  assert.deepEqual(parseMccAllowlist("  "), []);
});

test("controls: single-use + spend limit + currency, no MCC by default", () => {
  const c = buildAuthorizationControls({ amountCents: 2660, currency: "EUR" });
  assert.equal(c.allowed_transaction_count, "SINGLE");
  assert.deepEqual(c.transaction_limits, { currency: "EUR", limits: [{ interval: "ALL_TIME", amount: 26.6 }] });
  assert.equal("allowed_merchant_categories" in c, false);
});

test("controls: MCC allow-list included only when non-empty", () => {
  const c = buildAuthorizationControls({ amountCents: 5000, currency: "GBP", mccAllowlist: ["5992", "5193"] });
  assert.deepEqual(c.allowed_merchant_categories, ["5992", "5193"]);
  assert.equal(c.transaction_limits.currency, "GBP");

  const none = buildAuthorizationControls({ amountCents: 5000, currency: "GBP", mccAllowlist: [] });
  assert.equal("allowed_merchant_categories" in none, false);
});
