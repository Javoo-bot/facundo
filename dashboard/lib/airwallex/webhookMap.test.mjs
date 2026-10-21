import test from "node:test";
import assert from "node:assert/strict";
import { mapWebhookEvent } from "./webhookMap.ts";

const NOW = "2026-07-14T12:00:00.000Z";
const ev = (name, object) => ({ id: "evt", name, data: { object } });

test("clearing -> paid + settled_at + spent + last_txn + card USED", () => {
  const m = mapWebhookEvent(ev("issuing.transaction.succeeded", {
    id: "txn_1", card_id: "card_1", transaction_type: "CLEARING", transaction_amount: 26.6,
  }), NOW);
  assert.equal(m.eventType, "settled");
  assert.equal(m.cardId, "card_1");
  assert.deepEqual(m.payoutPatch, {
    status: "paid", settled_at: NOW, spent_amount: 26.6, last_txn_id: "txn_1", card_status: "USED",
  });
});

test("authorization -> records spend, keeps status (no status in patch)", () => {
  const m = mapWebhookEvent(ev("issuing.transaction.succeeded", {
    id: "txn_2", card_id: "card_2", transaction_type: "AUTHORIZATION", transaction_amount: 10,
  }), NOW);
  assert.equal(m.eventType, "authorized");
  assert.deepEqual(m.payoutPatch, { spent_amount: 10, last_txn_id: "txn_2" });
  assert.equal("status" in m.payoutPatch, false);
});

test("missing amount is omitted from patch (no null overwrite)", () => {
  const m = mapWebhookEvent(ev("issuing.transaction.succeeded", {
    id: "txn_3", card_id: "card_3", transaction_type: "AUTHORIZATION",
  }), NOW);
  assert.deepEqual(m.payoutPatch, { last_txn_id: "txn_3" });
  assert.equal("spent_amount" in m.payoutPatch, false);
});

test("failed -> declined, no patch", () => {
  const m = mapWebhookEvent(ev("issuing.transaction.failed", { id: "t", card_id: "card_9" }), NOW);
  assert.equal(m.eventType, "declined");
  assert.equal(m.payoutPatch, null);
  assert.equal(m.cardId, "card_9");
});

test("dispute modified -> stores status", () => {
  const m = mapWebhookEvent(ev("issuing.transaction_dispute.modified", { card_id: "c", status: "IN_PROGRESS" }), NOW);
  assert.equal(m.eventType, "dispute");
  assert.equal(m.disputeStatus, "IN_PROGRESS");
  assert.deepEqual(m.payoutPatch, { dispute_status: "IN_PROGRESS" });
});

test("dispute accepted with no explicit status -> ACCEPTED", () => {
  const m = mapWebhookEvent(ev("issuing.transaction_dispute.accepted", { card_id: "c" }), NOW);
  assert.equal(m.disputeStatus, "ACCEPTED");
  assert.deepEqual(m.payoutPatch, { dispute_status: "ACCEPTED" });
});

test("reissue -> recorded, no patch", () => {
  const m = mapWebhookEvent(ev("issuing.reissue.succeeded", { card_id: "c" }), NOW);
  assert.equal(m.eventType, "reissued");
  assert.equal(m.payoutPatch, null);
});

test("unknown event -> unhandled:<name>, never throws, no patch", () => {
  const m = mapWebhookEvent(ev("issuing.something.new", { card_id: "c" }), NOW);
  assert.equal(m.eventType, "unhandled:issuing.something.new");
  assert.equal(m.payoutPatch, null);
  const empty = mapWebhookEvent({}, NOW);
  assert.equal(empty.eventType, "unhandled:unknown");
  assert.equal(empty.cardId, null);
});

test("reads data.object OR flat data", () => {
  const flat = mapWebhookEvent({ name: "issuing.transaction.failed", data: { card_id: "flat" } }, NOW);
  assert.equal(flat.cardId, "flat");
});
