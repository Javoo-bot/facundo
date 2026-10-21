import test from "node:test";
import assert from "node:assert/strict";
import { orderStatusBadge, assignmentStatusBadge, sourceBadge } from "./badgeMap.ts";

test("order status maps to a badge class + label", () => {
  assert.deepEqual(orderStatusBadge("escalated"), { cls: "badge-crit", label: "Issue" });
  // badge-outreach, not the generic badge-warn: the order statuses were
  // given their own semantic palette (badge-created / badge-matched /
  // badge-outreach) after this test was written. The test never ran, so it
  // kept asserting the old shared colour.
  assert.deepEqual(orderStatusBadge("reaching_out"), { cls: "badge-outreach", label: "Reaching out" });
  assert.deepEqual(orderStatusBadge("in_production"), { cls: "badge-fulfilment", label: "In production" });
  assert.deepEqual(orderStatusBadge("delivered"), { cls: "badge-bloom", label: "Delivered" });
});

test("assignment status maps too", () => {
  assert.equal(assignmentStatusBadge("declined").cls, "badge-crit");
  assert.equal(assignmentStatusBadge("accepted").cls, "badge-accent");
  assert.equal(assignmentStatusBadge("opened").cls, "badge-amber");
});

test("florist source maps to existing/known/new colours", () => {
  assert.equal(sourceBadge("existing").cls, "badge-accent");
  assert.equal(sourceBadge("known").cls, "badge-warn");
  assert.equal(sourceBadge("new").cls, "badge-bloom");
});
