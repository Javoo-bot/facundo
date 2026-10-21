// Pure validation/diff logic for editable florist contact fields (per the brief's
// testing non-goal: a few assertions, no test framework). Run with:
// node --test lib/floristDetails.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDetailsUpdate, buildDetailsChangeNote } from "./floristDetails.ts";

test("accepts a Unicode local-part email", () => {
  const result = validateDetailsUpdate({ email: "concepciónperez@correo-demo.es" });
  assert.deepEqual(result, { ok: true, update: { email: "concepciónperez@correo-demo.es" } });
});

test("rejects a malformed email (no @)", () => {
  const result = validateDetailsUpdate({ email: "not-an-email" });
  assert.equal(result.ok, false);
});

test("accepts email: null to clear it", () => {
  const result = validateDetailsUpdate({ email: null });
  assert.deepEqual(result, { ok: true, update: { email: null } });
});

test("rejects an empty-string name", () => {
  const result = validateDetailsUpdate({ name: "   " });
  assert.equal(result.ok, false);
});

test("rejects a null name", () => {
  const result = validateDetailsUpdate({ name: null });
  assert.equal(result.ok, false);
});

test("trims a valid name", () => {
  const result = validateDetailsUpdate({ name: "  Flor Demo BCN  " });
  assert.deepEqual(result, { ok: true, update: { name: "Flor Demo BCN" } });
});

test("free-text fields: empty string stored as null", () => {
  const result = validateDetailsUpdate({ address: "  ", owner_name: "" });
  assert.deepEqual(result, { ok: true, update: { address: null, owner_name: null } });
});

test("free-text fields: trims non-empty values", () => {
  const result = validateDetailsUpdate({ phone_web: "  +34 600 000 000  " });
  assert.deepEqual(result, { ok: true, update: { phone_web: "+34 600 000 000" } });
});

test("only fields present in the body are included in the update", () => {
  const result = validateDetailsUpdate({ name: "Flor Demo BCN" });
  assert.deepEqual(result, { ok: true, update: { name: "Flor Demo BCN" } });
});

test("unrecognized fields in the body are ignored, not errors", () => {
  const result = validateDetailsUpdate({ name: "Flor Demo BCN", trust_tier: "1" });
  assert.deepEqual(result, { ok: true, update: { name: "Flor Demo BCN" } });
});

test("empty body produces an empty update", () => {
  assert.deepEqual(validateDetailsUpdate({}), { ok: true, update: {} });
});

test("buildDetailsChangeNote describes every changed field", () => {
  const before = { email: "old@example.com", phone_web: "111", name: "Old Name" };
  const update = { email: "new@example.com", phone_web: "111" };
  assert.equal(
    buildDetailsChangeNote(before, update),
    'Updated details — email: "old@example.com" → "new@example.com".'
  );
});

test("buildDetailsChangeNote returns null when nothing actually changed", () => {
  const before = { email: "same@example.com" };
  const update = { email: "same@example.com" };
  assert.equal(buildDetailsChangeNote(before, update), null);
});

test("buildDetailsChangeNote handles clearing a field to null", () => {
  const before = { owner_name: "Maria" };
  const update = { owner_name: null };
  assert.equal(buildDetailsChangeNote(before, update), 'Updated details — owner_name: "Maria" → "(empty)".');
});
