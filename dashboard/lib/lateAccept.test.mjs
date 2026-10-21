import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptBlockReason,
  ACCEPTABLE_ASSIGNMENT_STATUSES,
  ACCEPTABLE_ORDER_STATUSES,
} from "./lateAccept.ts";

const now = Date.now();
const inHours = (h) => new Date(now + h * 3600e3).toISOString();

// An order nobody holds, delivering in two days.
const openOrder = { status: "reaching_out", delivery_at: inHours(48), deleted_at: null };
// The offer whose window already lapsed — the case this module exists for.
const lapsed = { status: "expired", withdrawn_at: null };

test("a lapsed offer on an unclaimed order is acceptable", () => {
  assert.equal(acceptBlockReason(lapsed, openOrder, 2, now), null);
});

test("a live offer is acceptable too — this predicate governs every accept, not just late ones", () => {
  for (const status of ["candidate", "queued", "sent", "opened"]) {
    assert.equal(acceptBlockReason({ status, withdrawn_at: null }, openOrder, 2, now), null);
  }
});

test("a declined offer stays re-acceptable (changed-my-mind, pre-existing behaviour)", () => {
  assert.equal(acceptBlockReason({ status: "declined", withdrawn_at: null }, openOrder, 2, now), null);
});

test("a withdrawn offer is never acceptable, whatever its status", () => {
  const withdrawn = { status: "sent", withdrawn_at: inHours(-1) };
  assert.equal(acceptBlockReason(withdrawn, openOrder, 2, now), "withdrawn");
});

test("withdrawn outranks a status that would otherwise pass", () => {
  assert.equal(
    acceptBlockReason({ status: "expired", withdrawn_at: inHours(-1) }, openOrder, 2, now),
    "withdrawn"
  );
});

test("a terminal assignment can't be revived", () => {
  for (const status of ["accepted", "reassigned", "released", "delivered"]) {
    assert.equal(
      acceptBlockReason({ status, withdrawn_at: null }, openOrder, 2, now),
      "assignment-closed"
    );
  }
});

test("someone else already holds the order", () => {
  for (const status of ["accepted", "in_production", "ready", "out_for_delivery", "delivered", "paid", "closed", "cancelled"]) {
    assert.equal(
      acceptBlockReason(lapsed, { ...openOrder, status }, 2, now),
      "order-closed"
    );
  }
});

test("an escalated order is acceptable — rescuing it is the point of the feature", () => {
  assert.equal(acceptBlockReason(lapsed, { ...openOrder, status: "escalated" }, 2, now), null);
});

test("`received` stays blocked — semi mode parks orders there behind the CX match approval", () => {
  assert.equal(acceptBlockReason(lapsed, { ...openOrder, status: "received" }, 2, now), "order-closed");
});



test("just outside the buffer is fine", () => {
  const justOutside = { ...openOrder, delivery_at: inHours(2.5) };
  assert.equal(acceptBlockReason(lapsed, justOutside, 2, now), null);
});


test("null delivery_at never triggers too-late", () => {
  assert.equal(acceptBlockReason(lapsed, { ...openOrder, delivery_at: null }, 2, now), null);
});

test("a deleted order blocks ahead of everything else", () => {
  const deleted = { ...openOrder, deleted_at: inHours(-1), status: "accepted", delivery_at: inHours(0) };
  assert.equal(acceptBlockReason({ status: "accepted", withdrawn_at: inHours(-1) }, deleted, 2, now), "order-deleted");
});

test("the exported status sets are what the rules actually check", () => {
  assert.deepEqual(
    [...ACCEPTABLE_ASSIGNMENT_STATUSES].sort(),
    ["candidate", "declined", "expired", "opened", "queued", "sent"]
  );
  assert.deepEqual([...ACCEPTABLE_ORDER_STATUSES].sort(), ["escalated", "matched", "reaching_out"]);
});

// REPLACES the three buffer tests deleted here. Accepting used to be refused
// inside `late_accept_buffer_hours` of delivery. That rule produced order
// #2000019: unfulfilled at `reaching_out`, six offers out, 38 minutes to
// spare, and nobody able to take it. Whether there is time to deliver is the
// florist's judgement, not ours — the only questions we answer are whether the
// order is still open and whether someone else already took it.
test("a delivery minutes away is still acceptable while the order is open", () => {
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  assert.equal(
    acceptBlockReason({ status: "sent", withdrawn_at: null }, { status: "reaching_out", deleted_at: null, delivery_at: soon }),
    null
  );
});

test("a delivery already in the past is still acceptable — lateness is not closure", () => {
  assert.equal(
    acceptBlockReason({ status: "expired", withdrawn_at: null }, { status: "escalated", deleted_at: null }),
    null
  );
});

test("taken by another florist still blocks, which is the rule that matters", () => {
  assert.equal(
    acceptBlockReason({ status: "sent", withdrawn_at: null }, { status: "accepted", deleted_at: null }),
    "order-closed"
  );
});

// When the fulfilment SLA hands an order back and there is nobody to hand it
// to, lib/waves.ts escalates the ORDER and now closes the assignment as
// `released`. That word has to do three jobs at once, and if any of these sets
// ever admits it, the shop we took the order from keeps seeing it as theirs:
//
//   · the florist app's home list filters on assignment status, so `released`
//     must not be listed there (that filter lives in a page and cannot be
//     imported, so it is asserted by inspection, not here)
//   · lateAccept must refuse it — we gave up on them; a stale link must not
//     resurrect the order
//   · the call screen must not offer to phone them about an order they no
//     longer hold
test("a released assignment is out of the florist's reach in every direction", async () => {
  const { CALLABLE_STATUSES } = await import("./callCard.ts");
  assert.ok(!ACCEPTABLE_ASSIGNMENT_STATUSES.includes("released"), "lateAccept must refuse a released assignment");
  assert.ok(!CALLABLE_STATUSES.includes("released"), "the call screen must not offer a released shop");

  // And the accept predicate itself refuses it, not just the status list.
  assert.equal(
    acceptBlockReason({ status: "released", withdrawn_at: null }, { status: "escalated", deleted_at: null }),
    "assignment-closed",
  );
});
