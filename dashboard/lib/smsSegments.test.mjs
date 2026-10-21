import test from "node:test";
import assert from "node:assert/strict";
import { smsSegments, isGsm7, toGsm7Safe } from "./smsSegments.ts";

test("isGsm7 accepts plain ASCII and rejects Spanish acutes", () => {
  assert.equal(isGsm7("Plain ASCII text"), true);
  // GSM-7 includes à é ù ì ò ñ ü ä ö but NOT á í ó ú — the exact trap that
  // makes a Spanish/Italian message silently cost twice as much.
  assert.equal(isGsm7("Floristería"), false);
  assert.equal(isGsm7("café"), true);
});

test("smsSegments counts GSM-7 at 160/153 and UCS-2 at 70/67", () => {
  assert.equal(smsSegments("a".repeat(160)), 1);
  assert.equal(smsSegments("a".repeat(161)), 2);
  assert.equal(smsSegments("a".repeat(306)), 2); // 153 * 2
  assert.equal(smsSegments("a".repeat(307)), 3);
  assert.equal(smsSegments("í" + "a".repeat(69)), 1); // 70 UCS-2 chars
  assert.equal(smsSegments("í" + "a".repeat(70)), 2);
});

test("smsSegments treats an empty string as one segment", () => {
  assert.equal(smsSegments(""), 1);
});

test("toGsm7Safe folds accented Spanish city names to their GSM-7-safe ASCII form", () => {
  assert.equal(toGsm7Safe("Málaga"), "Malaga");
  assert.equal(toGsm7Safe("Córdoba"), "Cordoba");
  assert.equal(toGsm7Safe("Cádiz"), "Cadiz");
});

test("toGsm7Safe leaves already-GSM-7 characters unchanged (à é ù ì ò ñ ü ä ö)", () => {
  // è is in GSM-7 — must not be folded.
  assert.equal(toGsm7Safe("Genève"), "Genève");
  // ö is in GSM-7 — must not be folded.
  assert.equal(toGsm7Safe("Köln"), "Köln");
});

test("toGsm7Safe leaves a non-foldable script alone rather than destroying it", () => {
  const result = toGsm7Safe("Αθήνα");
  assert.notEqual(result, "");
  assert.notEqual(result, "?");
});

test("toGsm7Safe of an empty string is an empty string", () => {
  assert.equal(toGsm7Safe(""), "");
});
