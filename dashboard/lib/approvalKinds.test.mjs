// Unit tests for the pure step-mode (semi) approval helpers — the classification
// and row-shape the gate/executor/UI all depend on.
//   node --test lib/approvalKinds.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_KINDS, isEmailKind, isLoopAdvancing, rejectStatusFor, buildApprovalRow } from "./approvalKinds.ts";

test("email kinds are exactly offer + the three client notices", () => {
  const email = APPROVAL_KINDS.filter(isEmailKind);
  assert.deepEqual(email, ["offer", "client_assigned", "client_on_the_way", "client_delivered"]);
  assert.equal(isEmailKind("match"), false);
  assert.equal(isEmailKind("writeback"), false);
});

test("loop-advancing kinds block the order; notifications do not", () => {
  assert.equal(isLoopAdvancing("match"), true);
  assert.equal(isLoopAdvancing("offer"), true);
  assert.equal(isLoopAdvancing("reassign"), true);
  assert.equal(isLoopAdvancing("escalate"), true);
  assert.equal(isLoopAdvancing("writeback"), false);
  assert.equal(isLoopAdvancing("client_delivered"), false);
});

test("reject maps offer→skipped (try next) and everything else→rejected", () => {
  assert.equal(rejectStatusFor("offer"), "skipped");
  assert.equal(rejectStatusFor("match"), "rejected");
  assert.equal(rejectStatusFor("client_assigned"), "rejected");
  assert.equal(rejectStatusFor("writeback"), "rejected");
});

test("buildApprovalRow carries the dedupe_key + preview/payload + always pending/system", () => {
  const row = buildApprovalRow({
    kind: "client_delivered",
    orderId: "o1",
    dedupeKey: "client_delivered:o1",
    preview: { type: "email", to: "x@y.z", subject: "Delivered", html: "<b>hi</b>", testMode: true },
    payload: { notice: "delivered" },
    draftSubject: "Delivered",
    draftBody: "Your flowers arrived",
  });
  assert.equal(row.kind, "client_delivered");
  assert.equal(row.status, "pending");
  assert.equal(row.created_by, "system");
  assert.equal(row.dedupe_key, "client_delivered:o1");
  assert.equal(row.assignment_id, null); // defaulted when absent
  assert.equal(row.draft_subject, "Delivered");
  assert.deepEqual(row.payload, { notice: "delivered" });
  assert.equal(row.preview.html, "<b>hi</b>");
});

test("buildApprovalRow defaults optional fields to null (no undefined leaks to the DB)", () => {
  const row = buildApprovalRow({ kind: "match", orderId: "o2", dedupeKey: "match:o2", preview: null, payload: {} });
  assert.equal(row.assignment_id, null);
  assert.equal(row.draft_subject, null);
  assert.equal(row.draft_body, null);
});
