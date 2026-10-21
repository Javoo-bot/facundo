import test from "node:test";
import assert from "node:assert/strict";
import { outstandingExposure } from "./payoutExposure.ts";

const orderRow = (id, floristId, amount) => ({ id, amount, florist_id: null, order_assignments: { florist_id: floristId } });
const manualRow = (id, floristId, amount) => ({ id, amount, florist_id: floristId, order_assignments: null });

test("sums order-leg rows for the matching florist", () => {
  assert.equal(outstandingExposure([orderRow("p1", "f1", 50), orderRow("p2", "f1", 25)], "f1"), 75);
});

test("sums manual-leg rows for the matching florist — the gap this fixes", () => {
  assert.equal(outstandingExposure([orderRow("p1", "f1", 50), manualRow("p2", "f1", 25)], "f1"), 75);
});

test("ignores rows for a different florist", () => {
  assert.equal(outstandingExposure([orderRow("p1", "f1", 50), manualRow("p2", "f2", 999)], "f1"), 50);
});

test("excludePayoutId removes that specific row", () => {
  assert.equal(outstandingExposure([orderRow("p1", "f1", 50), manualRow("p2", "f1", 25)], "f1", "p2"), 50);
});

test("null amounts are guarded (never NaN)", () => {
  assert.equal(outstandingExposure([manualRow("p1", "f1", null)], "f1"), 0);
});

test("empty rows -> 0", () => {
  assert.equal(outstandingExposure([], "f1"), 0);
});
