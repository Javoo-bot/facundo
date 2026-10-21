// The reply-address token. Run with:
//   node --test lib/replyToken.test.mjs
process.env.REPLY_TOKEN_SECRET = "test-secret-for-reply-tokens";

import test from "node:test";
import assert from "node:assert/strict";
import {
  signReplyToken,
  verifyReplyToken,
  replyToAddress,
  tokenFromAddress,
  chooseReplyTo,
  inboundMailbox,
  uuidToBytes,
  bytesToUuid,
  REPLY_PREFIX,
  floristReplyAddress,
  signReplyTarget,
  verifyReplyTarget,
} from "./replyToken.ts";

const ASSIGNMENT = "3f2a1b4c-5d6e-4f80-9a1b-2c3d4e5f6071";
const OTHER = "00112233-4455-4677-8899-aabbccddeeff";

test("a minted token round-trips to the assignment it was minted for", () => {
  const token = signReplyToken(ASSIGNMENT);
  assert.ok(token);
  assert.equal(verifyReplyToken(token), ASSIGNMENT);
});

test("the whole address fits inside RFC 5321's 64-octet local-part limit", () => {
  // The reason the signature is truncated to 128 bits at all. If this ever
  // fails, the address is illegal and some receiving MTAs will reject the
  // reply outright — a bounce, not a missed match.
  const addr = replyToAddress(ASSIGNMENT, "reply.fc.example.net");
  const local = addr.slice(0, addr.lastIndexOf("@"));
  assert.ok(local.length <= 64, `local-part is ${local.length} octets: ${local}`);
});

test("a tampered payload does not verify", () => {
  const token = signReplyToken(ASSIGNMENT);
  const [payload, sig] = token.split(".");
  const otherPayload = signReplyToken(OTHER).split(".")[0];
  // Same signature, different assignment — the forgery this signs against.
  assert.equal(verifyReplyToken(`${otherPayload}.${sig}`), null);
  assert.equal(verifyReplyToken(`${payload}.${"A".repeat(sig.length)}`), null);
});

test("a token signed with a different secret does not verify", () => {
  const token = signReplyToken(ASSIGNMENT);
  const original = process.env.REPLY_TOKEN_SECRET;
  process.env.REPLY_TOKEN_SECRET = "a-different-secret";
  try {
    assert.equal(verifyReplyToken(token), null);
  } finally {
    process.env.REPLY_TOKEN_SECRET = original;
  }
});

test("malformed input is null, never a throw", () => {
  // This runs on a webhook path. A crash here is a 500 back to the provider and
  // a retry loop over a message that will never parse.
  for (const bad of ["", ".", "a.b.c", "!!!.???", "x".repeat(500), null, undefined]) {
    assert.equal(verifyReplyToken(bad), null);
  }
});

test("uuid conversion refuses anything that is not one", () => {
  assert.equal(uuidToBytes(""), null);
  assert.equal(uuidToBytes("not-a-uuid"), null);
  assert.equal(uuidToBytes(null), null);
  // Round trip, case-insensitively.
  assert.equal(bytesToUuid(uuidToBytes(ASSIGNMENT.toUpperCase())), ASSIGNMENT);
});

test("signing a non-uuid mints nothing rather than a token for the wrong thing", () => {
  assert.equal(signReplyToken("order-42"), null);
  assert.equal(replyToAddress("order-42", "reply.fc.example.net"), null);
});

test("with no secret configured, nothing is minted and nothing verifies", () => {
  // The state the repo is in until REPLY_TOKEN_SECRET is set: order emails ship
  // with the persona reply-to and matching falls back to header threading.
  const original = process.env.REPLY_TOKEN_SECRET;
  const outbox = process.env.OUTBOX_SECRET;
  delete process.env.REPLY_TOKEN_SECRET;
  delete process.env.OUTBOX_SECRET;
  try {
    assert.equal(signReplyToken(ASSIGNMENT), null);
    assert.equal(replyToAddress(ASSIGNMENT, "reply.fc.example.net"), null);
  } finally {
    process.env.REPLY_TOKEN_SECRET = original;
    if (outbox !== undefined) process.env.OUTBOX_SECRET = outbox;
  }
});

test("with no inbound domain configured, no reply-to is set", () => {
  // Until the MX record exists, an address on that domain would BOUNCE the
  // florist's reply. Not matching is recoverable; bouncing is not.
  assert.equal(replyToAddress(ASSIGNMENT, ""), null);
  assert.equal(replyToAddress(ASSIGNMENT, null), null);
});

test("the token is recovered from a recipient address", () => {
  const addr = replyToAddress(ASSIGNMENT, "reply.fc.example.net");
  assert.equal(verifyReplyToken(tokenFromAddress(addr)), ASSIGNMENT);
  // Display-name wrapping is the caller's job to strip; a bare address is what
  // arrives on the `to` array.
  assert.equal(tokenFromAddress("someone@example.com"), null);
  assert.equal(tokenFromAddress("persona@reply.fc.example.net"), null);
  assert.equal(tokenFromAddress(null), null);
});

test("the prefix matches case-insensitively but the token does not", () => {
  // Some MTAs normalise the local-part's case. The prefix must survive that;
  // the base64url payload must not be silently lowercased, because that would
  // turn a valid token into a rejected one.
  const addr = replyToAddress(ASSIGNMENT, "reply.fc.example.net");
  const token = tokenFromAddress(addr);
  const upperPrefix = addr.replace(REPLY_PREFIX, REPLY_PREFIX.toUpperCase());
  assert.equal(tokenFromAddress(upperPrefix), token);
  assert.equal(verifyReplyToken(token.toLowerCase()), null);
});

// ---- chooseReplyTo: where a florist's reply actually goes ----

test("chooseReplyTo: an explicit reply-to always wins", () => {
  assert.equal(chooseReplyTo("persona@fc.example.com", "r+tok@in.example", "florists@fc.example.com"), "persona@fc.example.com");
});

test("chooseReplyTo: the signed reply address beats the fallback once inbound mail is configured", () => {
  assert.equal(chooseReplyTo(null, "r+tok@in.example", "florists@fc.example.com"), "r+tok@in.example");
});

// The order #2000034 case: no inbound domain configured, so no token address.
// Before the fallback existed this returned nothing, the reply went to the
// From address, and it bounced.
test("chooseReplyTo: falls back to the monitored inbox when there is no token address", () => {
  assert.equal(chooseReplyTo(undefined, null, "florists@fc.example.com"), "florists@fc.example.com");
  assert.equal(chooseReplyTo("", "  ", "florists@fc.example.com"), "florists@fc.example.com");
});

test("chooseReplyTo: returns undefined, not null, when nothing applies", () => {
  assert.equal(chooseReplyTo(null, null, null), undefined);
  assert.equal(chooseReplyTo(undefined, undefined, undefined), undefined);
});

test("chooseReplyTo: every florist email prefers the app, then the monitored inbox", () => {
  // explicit > signed per-order address > general inbound mailbox > fallback
  assert.equal(chooseReplyTo(null, "r+tok@in.example", "florists@in.example", "florists@fc.example.com"), "r+tok@in.example");
  assert.equal(chooseReplyTo(null, null, "florists@in.example", "florists@fc.example.com"), "florists@in.example");
  assert.equal(chooseReplyTo(null, null, null, "florists@fc.example.com"), "florists@fc.example.com");
});

// ---- Florist tokens (recruiting mail) ----

const FLORIST = "11111111-2222-4333-8444-555555555555";

test("a florist reply address round-trips to the florist it was minted for", () => {
  const addr = floristReplyAddress(FLORIST, "reply.fc.example.net");
  assert.ok(addr.endsWith("@reply.fc.example.net"));
  assert.deepEqual(verifyReplyTarget(tokenFromAddress(addr)), { kind: "florist", id: FLORIST });
  const local = addr.slice(0, addr.lastIndexOf("@"));
  assert.ok(local.length <= 64, `local-part is ${local.length} octets: ${local}`);
});

test("a florist token is never read as an assignment, and an assignment token never as a florist", () => {
  // Same uuid under both kinds: the kind byte, not the id, decides.
  const florist = signReplyTarget({ kind: "florist", id: ASSIGNMENT });
  assert.equal(verifyReplyToken(florist), null);
  assert.deepEqual(verifyReplyTarget(signReplyToken(ASSIGNMENT)), { kind: "assignment", id: ASSIGNMENT });
});

test("relabelling a florist token's kind breaks its signature", () => {
  const [payload, sig] = signReplyTarget({ kind: "florist", id: FLORIST }).split(".");
  const bytes = Buffer.from(payload, "base64url");
  const stripped = bytes.subarray(1).toString("base64url");
  assert.equal(verifyReplyTarget(`${stripped}.${sig}`), null);
  const otherKind = Buffer.concat([Buffer.from([0x02]), bytes.subarray(1)]).toString("base64url");
  assert.equal(verifyReplyTarget(`${otherKind}.${sig}`), null);
});

test("a tampered florist token does not verify", () => {
  const [payload, sig] = signReplyTarget({ kind: "florist", id: FLORIST }).split(".");
  const other = signReplyTarget({ kind: "florist", id: OTHER }).split(".")[0];
  assert.equal(verifyReplyTarget(`${other}.${sig}`), null);
  assert.equal(verifyReplyTarget(`${payload}.${"A".repeat(sig.length)}`), null);
});

test("order tokens minted before florist tokens existed still verify", () => {
  // Pinned bytes: this is what signReplyToken produced for ASSIGNMENT under
  // this secret before the kind discriminator was added. Every order email
  // already sitting in a florist's inbox carries a token of this shape.
  const legacy = "PyobTF1uT4CaGyw9Tl9gcQ.OwyYvZ6vW5nYg9glQyi9BQ";
  assert.equal(verifyReplyToken(legacy), ASSIGNMENT);
  assert.equal(signReplyToken(ASSIGNMENT), legacy);
});

test("florist addresses are null until both a secret and a domain exist", () => {
  assert.equal(floristReplyAddress(FLORIST, ""), null);
  assert.equal(floristReplyAddress("not-a-uuid", "reply.fc.example.net"), null);
  const original = process.env.REPLY_TOKEN_SECRET;
  const outbox = process.env.OUTBOX_SECRET;
  delete process.env.REPLY_TOKEN_SECRET;
  delete process.env.OUTBOX_SECRET;
  try {
    assert.equal(floristReplyAddress(FLORIST, "reply.fc.example.net"), null);
  } finally {
    process.env.REPLY_TOKEN_SECRET = original;
    if (outbox !== undefined) process.env.OUTBOX_SECRET = outbox;
  }
});

test("inboundMailbox is null until an inbound domain exists, and is never a token", () => {
  assert.equal(inboundMailbox(""), null);
  assert.equal(inboundMailbox("abc123.resend.app"), "florists@abc123.resend.app");
  assert.equal(inboundMailbox("@abc123.resend.app"), "florists@abc123.resend.app");
  // Must not parse as a signed reply token, or it would be treated as one order.
  assert.equal(tokenFromAddress(inboundMailbox("abc123.resend.app")), null);
});
