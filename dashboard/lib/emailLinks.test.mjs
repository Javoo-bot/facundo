// Run: node --test lib/emailLinks.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { FLORIST_BASE, BACKOFFICE_BASE } from "./emailLinks.ts";
import { FLORIST_HOST, BACKOFFICE_HOST } from "./hostRouting.ts";

// The bases are captured at module load from the env, so these assert the
// resolution logic against whatever env the test process happens to carry.
test("bases follow the env-override + trailing-slash-strip logic", () => {
  assert.equal(FLORIST_BASE, (process.env.APP_BASE_URL || `https://${FLORIST_HOST}`).replace(/\/+$/, ""));
  assert.equal(BACKOFFICE_BASE, (process.env.BACKOFFICE_BASE_URL || `https://${BACKOFFICE_HOST}`).replace(/\/+$/, ""));
});

// The behaviour that matters in production, where both env vars are unset:
// florist email links must resolve on the florist host and staff email links on
// the backoffice host — and the two must differ, because each host 404s the
// other surface's routes (see lib/hostRouting.ts).
test("unset env → the two distinct gated fc.example.net hosts", (t) => {
  if (process.env.APP_BASE_URL || process.env.BACKOFFICE_BASE_URL) {
    t.skip("env overrides present in this process");
    return;
  }
  assert.equal(FLORIST_BASE, "https://florist.fc.example.net");
  assert.equal(BACKOFFICE_BASE, "https://bo.fc.example.net");
  assert.notEqual(FLORIST_BASE, BACKOFFICE_BASE);
  for (const base of [FLORIST_BASE, BACKOFFICE_BASE]) {
    assert.ok(base.endsWith("fc.example.net"), `${base} should be a fc.example.net host`);
    assert.ok(!base.includes("example.org"), "must not point at the retired dev domain");
  }
});
