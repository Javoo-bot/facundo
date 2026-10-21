import test from "node:test";
import assert from "node:assert/strict";
import { reconcileCardPayouts } from "./reconcile.ts";

// Same real-shaped fixtures as liveSummary.test.mjs / reconcilePatch.test.mjs.
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
const PENDING_AUTH = { ...SPENT_AUTH, status: "PENDING" };

// Minimal fake of the two Supabase call chains reconcileCardPayouts makes:
// admin.from("payouts").update(patch).eq("id", id) and
// admin.from("payment_events").insert(row). Records every call so tests can
// assert on exactly what was written (or that nothing was).
function fakeAdmin({ updateError = null } = {}) {
  const updates = [];
  const inserts = [];
  return {
    updates,
    inserts,
    from(table) {
      if (table === "payouts") {
        return {
          update(patch) {
            return {
              eq(col, id) {
                assert.equal(col, "id");
                updates.push({ id, patch });
                return Promise.resolve({ error: updateError });
              },
            };
          },
        };
      }
      if (table === "payment_events") {
        return {
          insert(row) {
            inserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`);
    },
  };
}

function row(overrides) {
  return {
    id: "p1",
    rail: "card",
    provider_ref: "card_p1",
    status: "issued",
    card_status: null,
    spent_amount: null,
    last_txn_id: null,
    ...overrides,
  };
}

test("a fully-settled card writes the patch, raw-negative spend, advances status to paid, and logs a reconciled_settled event", async () => {
  const admin = fakeAdmin();
  const rows = [row({ id: "settled-1", provider_ref: "card_settled" })];
  const fetchLive = async () => ({ card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN], partial: [] });

  const results = await reconcileCardPayouts(admin, rows, fetchLive);

  assert.deepEqual(results, [{ id: "settled-1", eligible: true, action: "settled" }]);
  assert.equal(admin.updates.length, 1);
  assert.equal(admin.updates[0].id, "settled-1");
  assert.equal(admin.updates[0].patch.spent_amount, -31.5); // raw negative, not liveSummary's positive magnitude
  assert.equal(admin.updates[0].patch.status, "paid");
  assert.equal(admin.updates[0].patch.card_status, "USED");
  assert.ok(admin.updates[0].patch.updated_at);
  assert.equal(admin.inserts.length, 1);
  assert.equal(admin.inserts[0].payout_id, "settled-1");
  assert.equal(admin.inserts[0].type, "reconciled_settled");
  assert.equal(admin.inserts[0].payload.source, "reconcile");
});

test("an authorized-but-unsettled card writes spend without advancing status, logs reconciled_authorized", async () => {
  const admin = fakeAdmin();
  const rows = [row({ id: "auth-1" })];
  const fetchLive = async () => ({ card: { card_status: "ACTIVE" }, authorizations: [PENDING_AUTH], transactions: [], partial: [] });

  const results = await reconcileCardPayouts(admin, rows, fetchLive);

  assert.deepEqual(results, [{ id: "auth-1", eligible: true, action: "authorized" }]);
  assert.equal(admin.updates[0].patch.spent_amount, -31.5);
  assert.equal(admin.updates[0].patch.status, undefined);
  assert.equal(admin.updates[0].patch.card_status, undefined);
  assert.equal(admin.inserts[0].type, "reconciled_authorized");
});

test("Airwallex shows no spend at all: does NOT advance the payout, writes nothing", async () => {
  const admin = fakeAdmin();
  const rows = [row({ id: "unspent-1" })];
  const fetchLive = async () => ({ card: { card_status: "ACTIVE" }, authorizations: [], transactions: [], partial: [] });

  const results = await reconcileCardPayouts(admin, rows, fetchLive);

  assert.deepEqual(results, [{ id: "unspent-1", eligible: true, action: "no-change" }]);
  assert.equal(admin.updates.length, 0);
  assert.equal(admin.inserts.length, 0);
});

test("a terminal-status payout (paid/failed/clawed_back) is reported skipped and never reaches Airwallex or the DB", async () => {
  const admin = fakeAdmin();
  const rows = [row({ id: "paid-1", status: "paid" }), row({ id: "failed-1", status: "failed" }), row({ id: "clawed-1", status: "clawed_back" })];
  let fetchLiveCalls = 0;
  const fetchLive = async () => {
    fetchLiveCalls += 1;
    return { card: null, authorizations: [], transactions: [], partial: [] };
  };

  const results = await reconcileCardPayouts(admin, rows, fetchLive);

  assert.deepEqual(
    results.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "clawed-1", eligible: false, reason: "not-reconcilable-status" },
      { id: "failed-1", eligible: false, reason: "not-reconcilable-status" },
      { id: "paid-1", eligible: false, reason: "not-reconcilable-status" },
    ],
  );
  assert.equal(fetchLiveCalls, 0);
  assert.equal(admin.updates.length, 0);
});

test("a ledger-rail or test-shop row is skipped with its liveCheckEligibility reason, never written", async () => {
  const admin = fakeAdmin();
  const rows = [
    row({ id: "ledger-1", rail: "ledger", provider_ref: "ledger:xyz" }),
    row({ id: "test-1", is_test_shop: true }),
  ];
  const fetchLive = async () => ({ card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN], partial: [] });

  const results = await reconcileCardPayouts(admin, rows, fetchLive);

  assert.deepEqual(
    results.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "ledger-1", eligible: false, reason: "ledger_or_no_card" },
      { id: "test-1", eligible: false, reason: "test_shop" },
    ],
  );
  assert.equal(admin.updates.length, 0);
  assert.equal(admin.inserts.length, 0);
});

test("re-running on an already-reconciled authorized row is a no-op (no duplicate write or event)", async () => {
  const admin = fakeAdmin();
  const rows = [row({ id: "already-1", spent_amount: -31.5, last_txn_id: "628e111e-90c5-48f1-963d-aebad3c35a83" })];
  const fetchLive = async () => ({ card: { card_status: "ACTIVE" }, authorizations: [PENDING_AUTH], transactions: [], partial: [] });

  const results = await reconcileCardPayouts(admin, rows, fetchLive);

  assert.deepEqual(results, [{ id: "already-1", eligible: true, action: "no-change" }]);
  assert.equal(admin.updates.length, 0);
  assert.equal(admin.inserts.length, 0);
});

test("a payout DB update failure is reported per-id and never masked as success; the audit insert is skipped", async () => {
  const admin = fakeAdmin({ updateError: { message: "connection reset" } });
  const rows = [row({ id: "dberr-1" })];
  const fetchLive = async () => ({ card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN], partial: [] });

  const results = await reconcileCardPayouts(admin, rows, fetchLive);

  assert.deepEqual(results, [{ id: "dberr-1", eligible: true, error: "connection reset" }]);
  assert.equal(admin.inserts.length, 0);
});

test("one card's Airwallex fetch failure does not lose track of the id or abandon the rest of the batch", async () => {
  const admin = fakeAdmin();
  const rows = [row({ id: "boom-1", provider_ref: "card_boom" }), row({ id: "settled-2", provider_ref: "card_settled_2" })];
  const fetchLive = async (cardId) => {
    if (cardId === "card_boom") throw new Error("network down");
    return { card: { card_status: "CLOSED" }, authorizations: [SPENT_AUTH], transactions: [SPENT_TXN], partial: [] };
  };

  const results = await reconcileCardPayouts(admin, rows, fetchLive);

  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId["boom-1"].eligible, true);
  assert.ok(byId["boom-1"].error);
  assert.equal(byId["settled-2"].action, "settled");
  assert.equal(admin.updates.length, 1);
  assert.equal(admin.updates[0].id, "settled-2");
});
