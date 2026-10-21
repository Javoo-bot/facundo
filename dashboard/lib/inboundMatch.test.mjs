// Matching an inbound reply to an order. Run with:
//   node --test lib/inboundMatch.test.mjs
process.env.REPLY_TOKEN_SECRET = "test-secret-for-reply-tokens";

import test from "node:test";
import assert from "node:assert/strict";
import { extractMatchKeys, pickMatch, parseMessageIds, newRfcMessageId, threadKind, matchInboundOrder } from "./inboundMatch.ts";
import { replyToAddress, floristReplyAddress, REPLY_PREFIX } from "./replyToken.ts";

const ASSIGNMENT = "3f2a1b4c-5d6e-4f80-9a1b-2c3d4e5f6071";
const ORDER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FLORIST = "11111111-2222-4333-8444-555555555555";
const OTHER_FLORIST = "99999999-8888-4777-8666-555555555554";
const DOMAIN = "reply.fc.example.net";

const assignmentRow = { id: ASSIGNMENT, order_id: ORDER, florist_id: FLORIST };
const MSG_ID = "<fc.1234@fc.example.com>";
const commRow = {
  rfc_message_id: MSG_ID,
  order_id: ORDER,
  florist_id: FLORIST,
  assignment_id: ASSIGNMENT,
};

test("a verified reply-address token names the assignment", () => {
  const keys = extractMatchKeys({ toAddresses: [replyToAddress(ASSIGNMENT, DOMAIN)] });
  assert.equal(keys.assignmentId, ASSIGNMENT);
});

test("the token wins over the headers", () => {
  // Both present and disagreeing happens for real: a florist replies to the
  // order email but their client quotes an older thread. The token was minted
  // for one assignment; the header chain is hearsay.
  const keys = extractMatchKeys({
    toAddresses: [replyToAddress(ASSIGNMENT, DOMAIN)],
    headers: { "in-reply-to": "<fc.other@fc.example.com>" },
  });
  const other = { ...commRow, rfc_message_id: "<fc.other@fc.example.com>", order_id: "different-order" };
  const m = pickMatch(keys, { assignment: assignmentRow, communications: [other] }, FLORIST);
  assert.equal(m.source, "reply-token");
  assert.equal(m.orderId, ORDER);
});

test("headers match when there is no token", () => {
  const keys = extractMatchKeys({ toAddresses: ["persona@reply.fc.example.net"], headers: { "In-Reply-To": MSG_ID } });
  assert.equal(keys.assignmentId, null);
  const m = pickMatch(keys, { communications: [commRow] }, FLORIST);
  assert.equal(m.source, "header-thread");
  assert.equal(m.orderId, ORDER);
  assert.equal(m.assignmentId, ASSIGNMENT);
});

test("header names are matched case-insensitively", () => {
  // Providers disagree: Resend lowercases, others preserve the wire casing.
  for (const name of ["in-reply-to", "In-Reply-To", "IN-REPLY-TO"]) {
    const keys = extractMatchKeys({ toAddresses: [], headers: { [name]: MSG_ID } });
    assert.deepEqual(keys.messageIds, [MSG_ID], `failed for ${name}`);
  }
});

test("References is read newest-first, and In-Reply-To outranks all of it", () => {
  // References runs oldest to newest. Reading it in file order would prefer the
  // FIRST message of a long thread — for a florist whose shop has had three
  // orders in one thread, that is the oldest and least relevant order.
  const keys = extractMatchKeys({
    toAddresses: [],
    headers: {
      references: "<fc.oldest@x> <fc.middle@x> <fc.newest@x>",
      "in-reply-to": "<fc.answered@x>",
    },
  });
  assert.deepEqual(keys.messageIds, [
    "<fc.answered@x>",
    "<fc.newest@x>",
    "<fc.middle@x>",
    "<fc.oldest@x>",
  ]);
});

test("a message-id appearing in both headers is not tried twice", () => {
  const keys = extractMatchKeys({
    toAddresses: [],
    headers: { "in-reply-to": MSG_ID, references: `<fc.old@x> ${MSG_ID}` },
  });
  assert.deepEqual(keys.messageIds, [MSG_ID, "<fc.old@x>"]);
});

test("a match naming a different florist than the sender is discarded", () => {
  // A forwarded thread: shop B replies to an email we sent shop A. The order is
  // real, but it is not theirs, and putting B's words on A's job is the one
  // outcome worse than not matching at all.
  const keys = extractMatchKeys({ toAddresses: [replyToAddress(ASSIGNMENT, DOMAIN)] });
  const m = pickMatch(keys, { assignment: assignmentRow, communications: [commRow] }, OTHER_FLORIST);
  assert.equal(m.source, "none");
  assert.equal(m.orderId, null);
});

test("an unknown sender does not block a match", () => {
  // We could not map the FROM address to a florist, but the token is ours and
  // is proof enough of which order this is. The conversation still escalates on
  // the unmatched sender; it escalates ATTACHED to the right order.
  const keys = extractMatchKeys({ toAddresses: [replyToAddress(ASSIGNMENT, DOMAIN)] });
  const m = pickMatch(keys, { assignment: assignmentRow }, null);
  assert.equal(m.source, "reply-token");
  assert.equal(m.floristId, FLORIST);
});

test("nothing matches when nothing is there — and that is a result, not a guess", () => {
  const keys = extractMatchKeys({ toAddresses: ["persona@reply.fc.example.net"], headers: null });
  assert.deepEqual(keys, { assignmentId: null, floristId: null, messageIds: [] });
  const m = pickMatch(keys, {}, FLORIST);
  assert.deepEqual(m, { orderId: null, assignmentId: null, floristId: null, source: "none" });
});

test("a communication with no order is skipped, not returned as a null match", () => {
  // Recruiting emails have no order_id. Threading onto one must fall through to
  // the next candidate rather than declaring a match with orderId null.
  const keys = extractMatchKeys({
    toAddresses: [],
    headers: { references: `<fc.recruit@x> ${MSG_ID}` },
  });
  const recruit = { rfc_message_id: "<fc.recruit@x>", order_id: null, florist_id: FLORIST, assignment_id: null };
  const m = pickMatch(keys, { communications: [recruit, commRow] }, FLORIST);
  assert.equal(m.source, "header-thread");
  assert.equal(m.orderId, ORDER);
});

test("an assignment row that does not match the token id is refused", () => {
  // Defence against a lookup returning the wrong row (a changed query, a stale
  // cache). The token said which assignment; anything else is not it.
  const keys = extractMatchKeys({ toAddresses: [replyToAddress(ASSIGNMENT, DOMAIN)] });
  const wrong = { id: "some-other-assignment", order_id: ORDER, florist_id: FLORIST };
  const m = pickMatch(keys, { assignment: wrong }, FLORIST);
  assert.equal(m.source, "none");
});

test("the subject line is never consulted", () => {
  // The guarantee the whole module exists for. An order number in the subject
  // is not a match, however tempting it looks in a support queue.
  const keys = extractMatchKeys({
    toAddresses: ["persona@reply.fc.example.net"],
    headers: { subject: "Re: Order #1042", "x-order": ORDER },
  });
  assert.deepEqual(keys, { assignmentId: null, floristId: null, messageIds: [] });
});

test("parseMessageIds reads angle brackets, not whitespace", () => {
  assert.deepEqual(parseMessageIds("<a@x>,<b@x>"), ["<a@x>", "<b@x>"]);
  assert.deepEqual(parseMessageIds("<a@x>\r\n\t<b@x>"), ["<a@x>", "<b@x>"]);
  assert.deepEqual(parseMessageIds(""), []);
  assert.deepEqual(parseMessageIds(null), []);
  assert.deepEqual(parseMessageIds("no brackets here"), []);
});

test("minted Message-IDs are angle-bracketed, unique, and on our domain", () => {
  const a = newRfcMessageId("fc.example.com");
  const b = newRfcMessageId("fc.example.com");
  assert.match(a, /^<fc\.[0-9a-f-]{36}@fc\.example\.com>$/);
  assert.notEqual(a, b);
  // Round-trips through the parser that will read it back off a reply.
  assert.deepEqual(parseMessageIds(a), [a]);
});

// ---- 2026-09-16: every florist email routes into the app ----

test("a reply to a florist-only email (no order) still identifies the florist", () => {
  // A magic link has no order. When the florist replies from an address we do
  // not recognise, the threading header is the only thing that says who they are.
  const keys = extractMatchKeys({ toAddresses: [], headers: { "in-reply-to": "<fc.magic@x>" } });
  const magic = { rfc_message_id: "<fc.magic@x>", order_id: null, florist_id: FLORIST, assignment_id: null };
  const m = pickMatch(keys, { communications: [magic] }, null);
  assert.deepEqual(m, { orderId: null, assignmentId: null, floristId: FLORIST, source: "header-thread-florist" });
});

test("a florist-only match never beats an order match", () => {
  const keys = extractMatchKeys({ toAddresses: [], headers: { references: `<fc.magic@x> ${MSG_ID}` } });
  const magic = { rfc_message_id: "<fc.magic@x>", order_id: null, florist_id: FLORIST, assignment_id: null };
  const m = pickMatch(keys, { communications: [magic, commRow] }, FLORIST);
  assert.equal(m.source, "header-thread");
  assert.equal(m.orderId, ORDER);
});

test("a florist-only match is discarded when a different shop is replying", () => {
  const keys = extractMatchKeys({ toAddresses: [], headers: { "in-reply-to": "<fc.magic@x>" } });
  const magic = { rfc_message_id: "<fc.magic@x>", order_id: null, florist_id: FLORIST, assignment_id: null };
  const m = pickMatch(keys, { communications: [magic] }, OTHER_FLORIST);
  assert.equal(m.source, "none");
  assert.equal(m.floristId, null);
});

// Order #2000034: a shop that had not joined replied to a cold offer asking how
// to accept it. Deciding by joined_at alone sent that to the recruiting
// assistant, which would have pitched joining instead of answering.
test("threadKind: a reply about an order is support, joined or not", () => {
  assert.equal(threadKind({ orderId: ORDER, joined: false }), "support");
  assert.equal(threadKind({ orderId: ORDER, joined: true }), "support");
  assert.equal(threadKind({ orderId: null, joined: true }), "support");
  assert.equal(threadKind({ orderId: null, joined: false }), "recruiting");
});

// ---- Recruiting replies: the signed per-florist reply address ----
//
// Card factory/card-92e8d9e4: 87 recruiting conversations escalated as
// "unmatched-sender" because a prospect's reply had only header threading to
// identify it. The first test is the card's diagnostic case 2, made a test.

const noDb = {
  from() {
    throw new Error("a florist reply token must resolve without a database lookup");
  },
};

test("a recruiting reply with its threading headers dropped is matched by the signed florist address", async () => {
  const replyTo = floristReplyAddress(FLORIST, DOMAIN);
  assert.ok(replyTo, "recruiting mail must be able to carry a signed florist reply address");
  const m = await matchInboundOrder(noDb, { toAddresses: [replyTo], headers: null }, null);
  assert.deepEqual(m, { orderId: null, assignmentId: null, floristId: FLORIST, source: "reply-token-florist" });
});

test("a florist reply token never invents an order and never beats an order match", () => {
  const keys = extractMatchKeys({
    toAddresses: [floristReplyAddress(FLORIST, DOMAIN)],
    headers: { "in-reply-to": MSG_ID },
  });
  assert.equal(keys.assignmentId, null);
  assert.equal(keys.floristId, FLORIST);
  const m = pickMatch(keys, { communications: [commRow] }, null);
  assert.equal(m.source, "header-thread");
  assert.equal(m.orderId, ORDER);
});

test("a florist reply token is discarded when a different shop is replying", () => {
  const keys = extractMatchKeys({ toAddresses: [floristReplyAddress(FLORIST, DOMAIN)] });
  const m = pickMatch(keys, {}, OTHER_FLORIST);
  assert.equal(m.source, "none");
  assert.equal(m.floristId, null);
});

test("headers naming a different shop than the florist token are refused", () => {
  // We minted the token for one florist. A header chain pointing at another
  // shop's order is a forwarded thread and must not land this reply there.
  const keys = extractMatchKeys({
    toAddresses: [floristReplyAddress(OTHER_FLORIST, DOMAIN)],
    headers: { "in-reply-to": MSG_ID },
  });
  const m = pickMatch(keys, { communications: [commRow] }, null);
  assert.deepEqual(m, { orderId: null, assignmentId: null, floristId: OTHER_FLORIST, source: "reply-token-florist" });
});

test("a tampered florist reply address falls back to nothing, without a throw", async () => {
  const addr = floristReplyAddress(FLORIST, DOMAIN);
  const i = REPLY_PREFIX.length;
  const tampered = addr.slice(0, i) + (addr[i] === "A" ? "B" : "A") + addr.slice(i + 1);
  assert.equal(extractMatchKeys({ toAddresses: [tampered] }).floristId, null);
  const m = await matchInboundOrder(noDb, { toAddresses: [tampered], headers: null }, null);
  assert.equal(m.source, "none");
});
