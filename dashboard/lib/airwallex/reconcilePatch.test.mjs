import test from "node:test";
import assert from "node:assert/strict";
import { summarizeLive } from "./liveSummary.ts";
import { computeReconcilePatch, reconcilePatchChanged, isReconcilableStatus, RECONCILABLE_STATUSES } from "./reconcilePatch.ts";

// Same real-shaped fixtures as liveSummary.test.mjs / liveCheckEligibility.test.mjs
// (the 2026-08-11 incident payout: 5d9451ae / order #2000024, fully drawn down
// while stored state stayed null).
const SPENT_TXN = {
  transaction_id: "db043527-b12f-4468-b7b7-1dc8d4a49bd7",
  transaction_type: "CLEARING",
  status: "APPROVED",
  billing_amount: -31.5, // Airwallex reports spend as negative
  billing_currency: "EUR",
  auth_code: "THG40T",
  posted_date: "2026-08-11T04:00:09.072+0000",
  merchant: { name: "FLOWER IMPACT", city: "PARIS" },
};
const SPENT_AUTH = {
  transaction_id: "628e111e-90c5-48f1-963d-aebad3c35a83",
  status: "CLEARED",
  billing_amount: -31.5,
  billing_currency: "EUR",
  auth_code: "THG40T",
  create_time: "2026-08-10T14:23:06.724+0000",
  merchant: { name: "FLOWER IMPACT" },
};
const STORED_UNTOUCHED = { status: "issued", card_status: null, spent_amount: null, last_txn_id: null };
const NOW = "2026-09-04T12:00:00.000Z";

test("isReconcilableStatus / RECONCILABLE_STATUSES", () => {
  for (const s of RECONCILABLE_STATUSES) assert.equal(isReconcilableStatus(s), true);
  assert.equal(isReconcilableStatus("paid"), false);
  assert.equal(isReconcilableStatus("failed"), false);
  assert.equal(isReconcilableStatus("clawed_back"), false);
  assert.equal(isReconcilableStatus(null), false);
});

test("settled: writes RAW NEGATIVE spend (webhookMap convention), USED card_status, settled_at, txn id, advances status to paid", () => {
  const summary = summarizeLive(
    { card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN] },
    STORED_UNTOUCHED,
  );
  // Sanity: liveSummary itself normalizes to a positive magnitude — the patch
  // below must flip it back to negative, not just forward it.
  assert.equal(summary.clearedTotal, 31.5);

  const outcome = computeReconcilePatch(summary, NOW);
  assert.equal(outcome.eventType, "reconciled_settled");
  assert.deepEqual(outcome.patch, {
    spent_amount: -31.5,
    settled_at: NOW,
    card_status: "USED",
    last_txn_id: "db043527-b12f-4468-b7b7-1dc8d4a49bd7",
    status: "paid",
  });
  assert.equal(outcome.eventPayload.source, "reconcile");
  assert.equal(outcome.eventPayload.clearedTotal, 31.5);
});

test("authorized but not yet cleared: records the hold, does NOT advance status or card_status", () => {
  const pending = { ...SPENT_AUTH, status: "PENDING" };
  const summary = summarizeLive({ card: { card_status: "ACTIVE" }, authorizations: [pending], transactions: [] }, STORED_UNTOUCHED);
  assert.equal(summary.pendingTotal, 31.5);

  const outcome = computeReconcilePatch(summary, NOW);
  assert.equal(outcome.eventType, "reconciled_authorized");
  assert.deepEqual(outcome.patch, {
    spent_amount: -31.5,
    last_txn_id: "628e111e-90c5-48f1-963d-aebad3c35a83",
  });
  assert.equal(outcome.patch.status, undefined);
  assert.equal(outcome.patch.card_status, undefined);
});

test("unspent card: patch is null — reconcile must never advance a payout Airwallex shows as unspent", () => {
  const summary = summarizeLive({ card: { card_status: "ACTIVE" }, authorizations: [], transactions: [] }, STORED_UNTOUCHED);
  const outcome = computeReconcilePatch(summary, NOW);
  assert.equal(outcome.patch, null);
  assert.equal(outcome.eventType, null);
});

test("a declined clearing row never counts as settled spend", () => {
  const declined = { ...SPENT_TXN, transaction_id: "d_1", status: "DECLINED" };
  const summary = summarizeLive({ card: { card_status: "ACTIVE" }, authorizations: [], transactions: [declined] }, STORED_UNTOUCHED);
  const outcome = computeReconcilePatch(summary, NOW);
  assert.equal(outcome.patch, null);
});

test("a fully-reversed card (nets to zero) is not reconciled as settled", () => {
  const reversal = { ...SPENT_TXN, transaction_id: "rev_1", billing_amount: 31.5 };
  const summary = summarizeLive({ card: { card_status: "CLOSED" }, authorizations: [], transactions: [SPENT_TXN, reversal] }, STORED_UNTOUCHED);
  assert.equal(summary.clearedTotal, 0);
  const outcome = computeReconcilePatch(summary, NOW);
  assert.equal(outcome.patch, null); // clearedTotal is 0, not > 0 — nothing to reconcile
});

test("reconcilePatchChanged: true when the settled patch disagrees with a still-unwritten row", () => {
  const patch = { spent_amount: -31.5, settled_at: NOW, card_status: "USED", last_txn_id: "t1", status: "paid" };
  assert.equal(reconcilePatchChanged(STORED_UNTOUCHED, patch), true);
});

test("reconcilePatchChanged: false once already reconciled to the same authorized state (no duplicate event on repeat ticks)", () => {
  const stored = { status: "issued", card_status: null, spent_amount: -31.5, last_txn_id: "628e111e-90c5-48f1-963d-aebad3c35a83" };
  const patch = { spent_amount: -31.5, last_txn_id: "628e111e-90c5-48f1-963d-aebad3c35a83" };
  assert.equal(reconcilePatchChanged(stored, patch), false);
});

test("reconcilePatchChanged: true when the amount drifted since the last reconcile", () => {
  const stored = { status: "issued", card_status: null, spent_amount: -20, last_txn_id: "t1" };
  const patch = { spent_amount: -31.5, last_txn_id: "t1" };
  assert.equal(reconcilePatchChanged(stored, patch), true);
});
