import test from "node:test";
import assert from "node:assert/strict";
import { canRevealCard, cardIfLive } from "./revealGuard.ts";

const ME = "florist-1";
const base = { florist_id: ME, rail: "card", provider_ref: "card_abc", status: "issued" };

test("owner + live card rail -> ok with cardId", () => {
  const d = canRevealCard(base, ME);
  assert.deepEqual(d, { ok: true, cardId: "card_abc" });
  assert.deepEqual(canRevealCard({ ...base, status: "paid" }, ME), { ok: true, cardId: "card_abc" });
});

test("missing payout -> 404", () => {
  assert.deepEqual(canRevealCard(null, ME), { ok: false, code: 404, error: "Payout not found." });
});

test("foreign payout -> 403", () => {
  assert.equal(canRevealCard({ ...base, florist_id: "someone-else" }, ME).code, 403);
  assert.equal(canRevealCard({ ...base, florist_id: null }, ME).code, 403);
});

test("ledger-rail / cardless payout -> 409", () => {
  assert.equal(canRevealCard({ ...base, rail: "sepa" }, ME).code, 409);
  assert.equal(canRevealCard({ ...base, provider_ref: null }, ME).code, 409);
  assert.equal(canRevealCard({ ...base, provider_ref: "ledger:xyz:accept" }, ME).code, 409);
});

test("clawed-back / failed card -> 409 no longer active", () => {
  assert.equal(canRevealCard({ ...base, status: "clawed_back" }, ME).code, 409);
  assert.equal(canRevealCard({ ...base, status: "failed" }, ME).code, 409);
});

test("ownership is checked before card existence (no info leak on foreign cardless payout)", () => {
  // foreign AND cardless -> still 403 (ownership first), not 409
  assert.equal(canRevealCard({ florist_id: "other", rail: "sepa", provider_ref: null, status: "issued" }, ME).code, 403);
});

test("cardIfLive (staff, no ownership): live card ok, ignores florist_id", () => {
  assert.deepEqual(cardIfLive({ florist_id: "anyone", rail: "card", provider_ref: "card_x", status: "issued" }), { ok: true, cardId: "card_x" });
  assert.equal(cardIfLive(null).code, 404);
  assert.equal(cardIfLive({ florist_id: null, rail: "sepa", provider_ref: null, status: "issued" }).code, 409);
  assert.equal(cardIfLive({ florist_id: null, rail: "card", provider_ref: "ledger:x", status: "issued" }).code, 409);
  assert.equal(cardIfLive({ florist_id: null, rail: "card", provider_ref: "card_x", status: "clawed_back" }).code, 409);
});
