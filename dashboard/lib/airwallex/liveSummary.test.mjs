import test from "node:test";
import assert from "node:assert/strict";
import { summarizeLive } from "./liveSummary.ts";

// Fixtures are the REAL Airwallex payloads for the three payouts inspected on
// 2026-08-11 (trimmed to the fields the summary reads). Using the real shapes
// matters: this module exists because our stored state disagreed with these
// exact responses.

// Payout 5d9451ae / order #2000024 — card fully drawn down.
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

// What the DB actually held for all three: nothing was ever written back.
const STORED_UNTOUCHED = { status: "issued", card_status: null, spent_amount: null, last_txn_id: null };

test("fully-spent card: reports positive total and flags that stored state missed it", () => {
  const s = summarizeLive(
    { card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN] },
    STORED_UNTOUCHED,
  );
  assert.equal(s.clearedTotal, 31.5); // sign normalized
  assert.equal(s.spent, true);
  assert.equal(s.currency, "EUR");
  assert.equal(s.transactions[0].amount, 31.5);
  assert.equal(s.transactions[0].merchant, "FLOWER IMPACT");

  const fields = s.drift.map((d) => d.field);
  assert.deepEqual(fields, ["spend", "last_txn_id", "card_status"]);
  assert.equal(s.drift[0].live, "spent 31.50 EUR");
  assert.equal(s.drift[0].stored, "not spent");
});

test("a CLEARED authorization is not double-counted on top of its transaction", () => {
  const s = summarizeLive(
    { card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN] },
    STORED_UNTOUCHED,
  );
  assert.equal(s.pendingTotal, null);
  assert.equal(s.clearedTotal, 31.5);
});

test("closed-but-never-used card: no spend drift, only card_status", () => {
  // Payout 1fff7f2b / order #2000013 — revealed 5x, never charged, then closed.
  const s = summarizeLive({ card: { card_status: "CLOSED" }, authorizations: [], transactions: [] }, STORED_UNTOUCHED);
  assert.equal(s.clearedTotal, null);
  assert.equal(s.spent, false);
  assert.deepEqual(s.drift.map((d) => d.field), ["card_status"]);
  assert.match(s.drift[0].note, /never recorded/);
});

test("active card with no authorizations: unspent, card_status drift only", () => {
  // Payout 3ffa21cf / order #2000025 — still live and spendable.
  const s = summarizeLive({ card: { card_status: "ACTIVE" }, authorizations: [], transactions: [] }, STORED_UNTOUCHED);
  assert.equal(s.spent, false);
  assert.deepEqual(s.drift.map((d) => d.field), ["card_status"]);
  assert.equal(s.drift[0].live, "ACTIVE");
});

test("no drift when stored already matches live", () => {
  const s = summarizeLive(
    { card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN] },
    {
      status: "paid",
      card_status: "USED", // our vocabulary for CLOSED — must NOT read as drift
      spent_amount: -31.5, // stored raw/negative by webhookMap — compared by magnitude
      last_txn_id: "db043527-b12f-4468-b7b7-1dc8d4a49bd7",
    },
  );
  assert.deepEqual(s.drift, []);
});

test("amount mismatch is caught when both sides agree money moved", () => {
  const s = summarizeLive(
    { card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN] },
    { status: "paid", card_status: "USED", spent_amount: -20, last_txn_id: "db043527-b12f-4468-b7b7-1dc8d4a49bd7" },
  );
  assert.deepEqual(s.drift.map((d) => d.field), ["spent_amount"]);
  assert.equal(s.drift[0].stored, "20.00 EUR");
  assert.equal(s.drift[0].live, "31.50 EUR");
});

test("a reversal nets out of the cleared total", () => {
  const reversal = { ...SPENT_TXN, transaction_id: "rev_1", billing_amount: 31.5 };
  const s = summarizeLive(
    { card: { card_status: "CLOSED" }, authorizations: [], transactions: [SPENT_TXN, reversal] },
    STORED_UNTOUCHED,
  );
  assert.equal(s.clearedTotal, 0);
  assert.equal(s.spent, false);
});

test("a declined clearing row never counts as spend", () => {
  const declined = { ...SPENT_TXN, transaction_id: "d_1", status: "DECLINED" };
  const s = summarizeLive({ card: { card_status: "ACTIVE" }, authorizations: [], transactions: [declined] }, STORED_UNTOUCHED);
  assert.equal(s.clearedTotal, null);
  assert.equal(s.spent, false);
});

test("a pending authorization counts as spend even before it clears", () => {
  const pending = { ...SPENT_AUTH, status: "PENDING" };
  const s = summarizeLive({ card: { card_status: "ACTIVE" }, authorizations: [pending], transactions: [] }, STORED_UNTOUCHED);
  assert.equal(s.pendingTotal, 31.5);
  assert.equal(s.spent, true);
  assert.equal(s.drift[0].field, "spend");
});

test("missing/garbage payloads degrade instead of throwing", () => {
  const s = summarizeLive({ card: null, authorizations: null, transactions: undefined }, STORED_UNTOUCHED);
  assert.equal(s.cardStatus, null);
  assert.equal(s.clearedTotal, null);
  assert.deepEqual(s.drift, []); // live tells us nothing — claim nothing
});
