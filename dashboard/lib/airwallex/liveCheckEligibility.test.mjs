import test from "node:test";
import assert from "node:assert/strict";
import {
  assessLiveCheckEligibility,
  needsLiveCheck,
  selectForLiveCheck,
  bulkLiveCheck,
} from "./liveCheckEligibility.ts";

// Reuse the same real-shaped fixtures as liveSummary.test.mjs (the payout
// this module was designed around: 5d9451ae / order #2000024, fully drawn
// down while stored state stayed null).
const SPENT_TXN = {
  transaction_id: "db043527-b12f-4468-b7b7-1dc8d4a49bd7",
  transaction_type: "CLEARING",
  status: "APPROVED",
  billing_amount: -31.5,
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

const CARD_ACTIVE = { id: "p1", rail: "card", provider_ref: "card_abc", status: "issued", card_status: null, spent_amount: null, last_txn_id: null };
const LEDGER = { id: "p2", rail: "ledger", provider_ref: "ledger:xyz", status: "issued", card_status: null, spent_amount: null, last_txn_id: null };
const CARD_NO_REF = { id: "p3", rail: "card", provider_ref: null, status: "issued", card_status: null, spent_amount: null, last_txn_id: null };
const CARD_CLAWED_BACK = { id: "p4", rail: "card", provider_ref: "card_def", status: "clawed_back", card_status: "ACTIVE", spent_amount: null, last_txn_id: null };
const CARD_FAILED = { id: "p5", rail: "card", provider_ref: "card_ghi", status: "failed", card_status: null, spent_amount: null, last_txn_id: null };
const CARD_KNOWN_STATUS = { id: "p6", rail: "card", provider_ref: "card_jkl", status: "issued", card_status: "ACTIVE", spent_amount: null, last_txn_id: null };
const CARD_USED = { id: "p7", rail: "card", provider_ref: "card_mno", status: "paid", card_status: "USED", spent_amount: -31.5, last_txn_id: "t1" };
const TEST_SHOP_CARD = { id: "p9", rail: "card", provider_ref: "card_test", status: "issued", is_test_shop: true, card_status: null, spent_amount: null, last_txn_id: null };

test("assessLiveCheckEligibility: card-rail, active status, real provider_ref -> eligible", () => {
  const r = assessLiveCheckEligibility({ rail: "card", provider_ref: "card_abc", status: "issued" });
  assert.deepEqual(r, { eligible: true, cardId: "card_abc" });
});

test("assessLiveCheckEligibility: ledger rail -> ledger_or_no_card", () => {
  const r = assessLiveCheckEligibility({ rail: "ledger", provider_ref: "ledger:xyz", status: "issued" });
  assert.deepEqual(r, { eligible: false, reason: "ledger_or_no_card" });
});

test("assessLiveCheckEligibility: card rail but ledger: sentinel provider_ref -> ledger_or_no_card", () => {
  const r = assessLiveCheckEligibility({ rail: "card", provider_ref: "ledger:abc:accept", status: "issued" });
  assert.deepEqual(r, { eligible: false, reason: "ledger_or_no_card" });
});

test("assessLiveCheckEligibility: card rail, missing provider_ref -> ledger_or_no_card", () => {
  const r = assessLiveCheckEligibility({ rail: "card", provider_ref: null, status: "issued" });
  assert.deepEqual(r, { eligible: false, reason: "ledger_or_no_card" });
});

test("assessLiveCheckEligibility: test/demo shop is skipped even if the row wrongly has a card ref", () => {
  const r = assessLiveCheckEligibility({ rail: "card", provider_ref: "card_test", status: "issued", is_test_shop: true });
  assert.deepEqual(r, { eligible: false, reason: "test_shop" });
});

test("assessLiveCheckEligibility: clawed_back -> card_inactive", () => {
  const r = assessLiveCheckEligibility({ rail: "card", provider_ref: "card_abc", status: "clawed_back" });
  assert.deepEqual(r, { eligible: false, reason: "card_inactive" });
});

test("assessLiveCheckEligibility: failed -> card_inactive", () => {
  const r = assessLiveCheckEligibility({ rail: "card", provider_ref: "card_abc", status: "failed" });
  assert.deepEqual(r, { eligible: false, reason: "card_inactive" });
});

test("needsLiveCheck: true only when eligible AND card_status null", () => {
  assert.equal(needsLiveCheck(CARD_ACTIVE), true);
});

test("needsLiveCheck: false when card_status is any non-null string", () => {
  assert.equal(needsLiveCheck(CARD_KNOWN_STATUS), false);
  assert.equal(needsLiveCheck(CARD_USED), false);
});

test("needsLiveCheck: false when not eligible at all, even with null card_status", () => {
  assert.equal(needsLiveCheck(LEDGER), false);
  assert.equal(needsLiveCheck(CARD_NO_REF), false);
  assert.equal(needsLiveCheck(CARD_FAILED), false);
  assert.equal(needsLiveCheck(TEST_SHOP_CARD), false);
});

test("selectForLiveCheck: partitions a mixed batch and computes needsCheck per eligible row", () => {
  const batch = [CARD_ACTIVE, LEDGER, CARD_NO_REF, CARD_CLAWED_BACK, CARD_FAILED, CARD_KNOWN_STATUS, CARD_USED, TEST_SHOP_CARD];
  const { eligible, skipped } = selectForLiveCheck(batch);

  assert.deepEqual(
    eligible.map((e) => e.id).sort(),
    ["p1", "p6", "p7"].sort(),
  );
  assert.deepEqual(
    skipped.map((s) => s.id).sort(),
    ["p2", "p3", "p4", "p5", "p9"].sort(),
  );

  const skippedById = new Map(skipped.map((s) => [s.id, s.reason]));
  assert.equal(skippedById.get("p2"), "ledger_or_no_card"); // ledger
  assert.equal(skippedById.get("p3"), "ledger_or_no_card"); // no provider_ref
  assert.equal(skippedById.get("p4"), "card_inactive"); // clawed_back
  assert.equal(skippedById.get("p5"), "card_inactive"); // failed
  assert.equal(skippedById.get("p9"), "test_shop"); // demo/test shop

  const eligibleById = new Map(eligible.map((e) => [e.id, e.needsCheck]));
  assert.equal(eligibleById.get("p1"), true); // card_status null
  assert.equal(eligibleById.get("p6"), false); // card_status ACTIVE
  assert.equal(eligibleById.get("p7"), false); // card_status USED
});

test("bulkLiveCheck: eligible row gets a summary with drift computed by real summarizeLive", async () => {
  const fetchLive = async (cardId) => {
    assert.equal(cardId, "card_abc");
    return { card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN], partial: [] };
  };

  const results = await bulkLiveCheck([CARD_ACTIVE], fetchLive);
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.id, "p1");
  assert.equal(r.eligible, true);
  assert.ok(r.summary);
  assert.equal(r.summary.clearedTotal, 31.5);
  assert.equal(r.summary.spent, true);
  assert.deepEqual(
    r.summary.drift.map((d) => d.field),
    ["spend", "last_txn_id", "card_status"],
  );
  assert.deepEqual(r.partial, []);
});

test("bulkLiveCheck: skipped rows are included with eligible:false and correct reason, fetchLive is never called for them", async () => {
  const calls = [];
  const fetchLive = async (cardId) => {
    calls.push(cardId);
    return { card: null, authorizations: [], transactions: [], partial: [] };
  };

  const results = await bulkLiveCheck([LEDGER, TEST_SHOP_CARD, CARD_ACTIVE], fetchLive);

  assert.deepEqual(calls, ["card_abc"]); // only the eligible row's cardId was fetched

  const byId = new Map(results.map((r) => [r.id, r]));
  assert.deepEqual(byId.get("p2"), { id: "p2", eligible: false, reason: "ledger_or_no_card" });
  assert.deepEqual(byId.get("p9"), { id: "p9", eligible: false, reason: "test_shop" });
  assert.equal(byId.get("p1").eligible, true);
});

test("bulkLiveCheck: a throwing fetchLive for one id doesn't blow up the batch; others still resolve", async () => {
  const OTHER = { ...CARD_KNOWN_STATUS, id: "p8", provider_ref: "card_ok" };

  const fetchLive = async (cardId) => {
    if (cardId === "card_abc") throw new Error("network down");
    return { card: { card_status: "ACTIVE" }, authorizations: [], transactions: [], partial: [] };
  };

  const results = await bulkLiveCheck([CARD_ACTIVE, OTHER], fetchLive);
  const byId = new Map(results.map((r) => [r.id, r]));

  const failed = byId.get("p1");
  assert.equal(failed.eligible, true);
  assert.equal(failed.error, "Could not reach Airwallex right now.");
  assert.equal(failed.summary, undefined);

  const ok = byId.get("p8");
  assert.equal(ok.eligible, true);
  assert.ok(ok.summary);
  assert.equal(ok.error, undefined);
});

test("bulkLiveCheck: does not invent currency or format money — passes summarizeLive's output through untouched", async () => {
  // No transactions/authorizations at all -> summarizeLive returns nulls, not "0.00"/made-up currency.
  const fetchLive = async () => ({ card: { card_status: "ACTIVE" }, authorizations: [], transactions: [], partial: [] });

  const results = await bulkLiveCheck([CARD_ACTIVE], fetchLive);
  const r = results[0];
  assert.equal(r.summary.clearedTotal, null);
  assert.equal(r.summary.pendingTotal, null);
  assert.equal(r.summary.currency, null);
  assert.equal(r.summary.spent, false);
});
