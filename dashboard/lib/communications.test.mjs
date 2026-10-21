import test from "node:test";
import assert from "node:assert/strict";
import { buildCommunicationRow } from "./communicationsRow.ts";

test("buildCommunicationRow: email offer to a florist", () => {
  const row = buildCommunicationRow({
    channel: "email",
    audience: "florist",
    kind: "offer",
    orderId: "order-1",
    floristId: "florist-1",
    assignmentId: "assignment-1",
    to: "test@example.com",
    subject: "New Facundo order",
    body: "You have a new order — please review in your Facundo dashboard.",
    testMode: true,
    status: "sent",
    provider: "resend",
    providerMessageId: "resend-msg-1",
    actor: "system",
  });
  assert.deepEqual(row, {
    channel: "email",
    audience: "florist",
    kind: "offer",
    order_id: "order-1",
    florist_id: "florist-1",
    assignment_id: "assignment-1",
    issue_id: null,
    to_address: "test@example.com",
    subject: "New Facundo order",
    body: "You have a new order — please review in your Facundo dashboard.",
    html: null,
    test_mode: true,
    status: "sent",
    provider: "resend",
    provider_message_id: "resend-msg-1",
    // Null here on purpose: this caller passes no rfcMessageId. sendEmail
    // always mints one, so a null in a real row means the send did not go
    // through sendEmail — which is exactly what the threading match will find
    // (or fail to find) later.
    rfc_message_id: null,
    error: null,
    actor: "system",
  });
});

test("buildCommunicationRow: client notice has no florist/assignment/issue attribution", () => {
  const row = buildCommunicationRow({
    channel: "email",
    audience: "client",
    kind: "client_delivered",
    orderId: "order-2",
    to: "buyer@example.com",
    subject: "Your Facundo order has been delivered",
    body: "Your order has been delivered.",
    testMode: false,
    status: "sent",
    provider: "resend",
    providerMessageId: "resend-msg-2",
    actor: "system",
  });
  assert.equal(row.audience, "client");
  assert.equal(row.kind, "client_delivered");
  assert.equal(row.order_id, "order-2");
  assert.equal(row.florist_id, null);
  assert.equal(row.assignment_id, null);
  assert.equal(row.issue_id, null);
  assert.equal(row.test_mode, false);
  assert.equal(row.status, "sent");
});

test("buildCommunicationRow: push has no subject and no provider_message_id", () => {
  const row = buildCommunicationRow({
    channel: "push",
    audience: "florist",
    kind: "offer_push",
    orderId: "order-3",
    floristId: "florist-3",
    assignmentId: "assignment-3",
    body: "New Facundo order — your payout €12",
    testMode: true,
    status: "sent",
    provider: "web-push",
    actor: "system",
  });
  assert.equal(row.channel, "push");
  assert.equal(row.subject, null); // no subject param given → defaults to null
  assert.equal(row.to_address, null); // no `to` given for a batch push
  assert.equal(row.provider, "web-push");
  assert.equal(row.provider_message_id, null);
  assert.equal(row.body, "New Facundo order — your payout €12");
});

test("buildCommunicationRow: html is stored when the send provided a rendered alternative", () => {
  const row = buildCommunicationRow({
    channel: "email",
    audience: "client",
    kind: "client_delivered",
    orderId: "order-5",
    to: "buyer@example.com",
    subject: "Your Facundo order has been delivered",
    body: "Your order has been delivered.",
    html: "<html><body>Your order has been delivered.</body></html>",
    testMode: false,
    status: "sent",
    provider: "resend",
    providerMessageId: "resend-msg-5",
    actor: "system",
  });
  assert.equal(row.html, "<html><body>Your order has been delivered.</body></html>");
});

test("buildCommunicationRow: html defaults to null when the caller doesn't pass one (e.g. push)", () => {
  const row = buildCommunicationRow({
    channel: "push",
    audience: "florist",
    kind: "offer_push",
    orderId: "order-6",
    floristId: "florist-6",
    body: "New Facundo order — your payout €12",
    testMode: true,
    status: "sent",
    provider: "web-push",
    actor: "system",
  });
  assert.equal(row.html, null);
});

test("buildCommunicationRow: skipped send records the reason and no provider id", () => {
  const row = buildCommunicationRow({
    channel: "email",
    audience: "cx",
    kind: "issue_to_cx",
    orderId: "order-4",
    testMode: true,
    status: "skipped",
    provider: "resend",
    error: "no-cx-or-test-email",
    actor: "florist@example.com",
  });
  assert.equal(row.status, "skipped");
  assert.equal(row.error, "no-cx-or-test-email");
  assert.equal(row.to_address, null);
  assert.equal(row.subject, null);
  assert.equal(row.body, null);
  assert.equal(row.provider_message_id, null);
});
