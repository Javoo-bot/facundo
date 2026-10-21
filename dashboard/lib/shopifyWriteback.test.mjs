import { test } from "node:test";
import assert from "node:assert/strict";
import { unionTags, formatPayoutTotal } from "./shopifyTags.ts";

test("unionTags adds the tag when there are no existing tags", () => {
  assert.equal(unionTags(null, "facundo"), "facundo");
  assert.equal(unionTags(undefined, "facundo"), "facundo");
  assert.equal(unionTags("", "facundo"), "facundo");
});

test("unionTags preserves existing tags and appends the new one", () => {
  assert.equal(unionTags("vip, rush", "facundo"), "vip, rush, facundo");
});

test("unionTags dedupes case-insensitively without altering existing casing", () => {
  assert.equal(unionTags("VIP, Facundo", "facundo"), "VIP, Facundo");
  assert.equal(unionTags("facundo", "facundo"), "facundo");
});

test("unionTags trims whitespace and drops empty entries", () => {
  assert.equal(unionTags(" vip ,, rush ,", "facundo"), "vip, rush, facundo");
});

// --- formatPayoutTotal: the "Tookan Cost Of Order" metafield string ---------
// Format confirmed against live production values on 2026-08-21: a bare
// 2dp number, no currency suffix (e.g. real orders show "31.80", "41.70").

test("formatPayoutTotal renders to exactly 2 decimal places", () => {
  assert.equal(formatPayoutTotal(42.5), "42.50");
  // Epsilon-guarded cent rounding (not a bare .toFixed(2)) so a value that
  // lands a hair under its true cent in IEEE-754 still rounds the direction
  // a human doing exact decimal rounding would expect.
  assert.equal(formatPayoutTotal(41.635), "41.64");
});

test("formatPayoutTotal on a whole number still shows 2 decimal places", () => {
  assert.equal(formatPayoutTotal(41), "41.00");
});

test("formatPayoutTotal on zero", () => {
  assert.equal(formatPayoutTotal(0), "0.00");
});

test("formatPayoutTotal cleans up the IEEE-754 dust sumPayoutLegs could otherwise carry", () => {
  // See lib/payoutMath.test.mjs — sumPayoutLegs itself is now cent-safe, so
  // this dusty input is now a hypothetical (a caller bypassing sumPayoutLegs),
  // but formatPayoutTotal is defensive here regardless.
  assert.equal(formatPayoutTotal(0.30000000000000004), "0.30");
});
