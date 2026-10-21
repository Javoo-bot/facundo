import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFLICT_EVENT,
  CONFLICT_RESOLVED_EVENT,
  unresolvedConflictOrderIds,
  hasUnresolvedConflict,
  describeConflictCloseImpact,
} from "./shopifyConflict.ts";

test("unresolvedConflictOrderIds keeps orders with a conflict and no resolution", () => {
  const rows = [
    { order_id: "a", type: CONFLICT_EVENT },
    { order_id: "b", type: CONFLICT_EVENT },
    { order_id: "b", type: CONFLICT_RESOLVED_EVENT },
    { order_id: "c", type: CONFLICT_RESOLVED_EVENT }, // resolved with no conflict row (defensive — shouldn't happen, but never flag it)
  ];
  const out = unresolvedConflictOrderIds(rows);
  assert.deepEqual([...out], ["a"]);
});

test("unresolvedConflictOrderIds is empty when there are no rows", () => {
  assert.deepEqual([...unresolvedConflictOrderIds([])], []);
});

test("hasUnresolvedConflict: true only when a conflict event exists with no resolution", () => {
  assert.equal(hasUnresolvedConflict([{ type: CONFLICT_EVENT }]), true);
  assert.equal(hasUnresolvedConflict([{ type: CONFLICT_EVENT }, { type: CONFLICT_RESOLVED_EVENT }]), false);
  assert.equal(hasUnresolvedConflict([]), false);
  assert.equal(hasUnresolvedConflict([{ type: "status:accepted" }]), false);
});

test("hasUnresolvedConflict ignores event ordering — a resolution always wins", () => {
  // order_events.select in the routes has no ORDER BY, so the resolved row could
  // come back before the conflict row — the check must not depend on array order.
  assert.equal(hasUnresolvedConflict([{ type: CONFLICT_RESOLVED_EVENT }, { type: CONFLICT_EVENT }]), false);
});

test("describeConflictCloseImpact: no warning when there's no live assignment", () => {
  const out = describeConflictCloseImpact({ assignmentStatus: null, floristName: "Bloom & Co", hasDeliveryPayout: false });
  assert.equal(out.needsWarning, false);
  assert.equal(out.warning, null);
});

test("describeConflictCloseImpact: delivery payout not yet issued — warns it can still be triggered later", () => {
  const out = describeConflictCloseImpact({ assignmentStatus: "accepted", floristName: "Bloom & Co", hasDeliveryPayout: false });
  assert.equal(out.needsWarning, true);
  assert.match(out.warning, /Bloom & Co/);
  assert.match(out.warning, /delivery photo/);
  assert.match(out.warning, /flips back to "Delivered"/);
});

test("describeConflictCloseImpact: delivery payout already exists — closing is just a status catch-up", () => {
  const out = describeConflictCloseImpact({ assignmentStatus: "delivered", floristName: "Bloom & Co", hasDeliveryPayout: true });
  assert.equal(out.needsWarning, true);
  assert.match(out.warning, /does not touch the assignment or any payout/);
});

test("describeConflictCloseImpact falls back to a generic name when the florist is unknown", () => {
  const out = describeConflictCloseImpact({ assignmentStatus: "accepted", floristName: null, hasDeliveryPayout: false });
  assert.match(out.warning, /^The assigned florist/);
});
