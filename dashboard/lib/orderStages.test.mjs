import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGES,
  stageOf,
  stageIndex,
  moveDirection,
  staffSettableStatuses,
  canStaffSet,
} from "./orderStages.ts";

test("stageOf maps every happy-path status to the right display stage", () => {
  assert.equal(stageOf("received"), "created");
  assert.equal(stageOf("matched"), "matched");
  assert.equal(stageOf("reaching_out"), "outreach");
  for (const s of ["accepted", "in_production", "ready"]) assert.equal(stageOf(s), "fulfilment");
  assert.equal(stageOf("out_for_delivery"), "delivery");
  for (const s of ["delivered", "paid", "closed"]) assert.equal(stageOf(s), "delivered");
});

test("stageOf marks the two off-path states as overlays", () => {
  assert.equal(stageOf("escalated"), "escalated");
  assert.equal(stageOf("cancelled"), "cancelled");
});

test("STAGES are ordered and stageIndex agrees", () => {
  assert.deepEqual(STAGES.map((s) => s.id), ["created", "matched", "outreach", "fulfilment", "delivery", "delivered"]);
  assert.equal(stageIndex("created"), 0);
  assert.equal(stageIndex("delivered"), 5);
});

test("moveDirection classifies forward, back, and flag", () => {
  assert.equal(moveDirection("matched", "reaching_out"), "forward");
  assert.equal(moveDirection("reaching_out", "matched"), "back");
  assert.equal(moveDirection("ready", "out_for_delivery"), "forward");
  assert.equal(moveDirection("delivered", "out_for_delivery"), "back");
  assert.equal(moveDirection("reaching_out", "escalated"), "flag");
  assert.equal(moveDirection("reaching_out", "cancelled"), "flag");
});

test("staffSettableStatuses offers forward + back + escalate/cancel and never the current", () => {
  const moves = staffSettableStatuses("ready");
  const byStatus = new Map(moves.map((m) => [m.status, m.direction]));
  assert.equal(byStatus.get("out_for_delivery"), "forward"); // forward step
  assert.equal(byStatus.get("in_production"), "back"); // sensible back-step
  assert.equal(byStatus.get("escalated"), "flag");
  assert.equal(byStatus.get("cancelled"), "flag");
  assert.ok(!byStatus.has("ready")); // never the current status
  assert.ok(!byStatus.has("delivered")); // not a legal single move from ready
});

test("outreach can go back to matched and forward to accepted", () => {
  assert.ok(canStaffSet("reaching_out", "matched")); // the 'back to matched' the user asked for
  assert.ok(canStaffSet("reaching_out", "accepted"));
  assert.ok(canStaffSet("accepted", "reaching_out")); // reassignment loop
});

test("terminal states only reopen (no forward, no escalate)", () => {
  const closed = staffSettableStatuses("closed").map((m) => m.status);
  assert.deepEqual(closed, ["delivered"]); // reopen only
  assert.ok(!canStaffSet("closed", "escalated"));
  assert.ok(!canStaffSet("closed", "cancelled"));

  const cancelled = staffSettableStatuses("cancelled").map((m) => m.status);
  assert.deepEqual(cancelled, ["reaching_out"]); // reopen only
});

test("flags sort last in the offered list", () => {
  const moves = staffSettableStatuses("accepted");
  const lastTwo = moves.slice(-2).map((m) => m.status).sort();
  assert.deepEqual(lastTwo, ["cancelled", "escalated"]);
});
