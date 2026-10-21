// The address a florist's reply comes back to, carrying which order it is about.
//
// Every order email goes out with `Reply-To: r+<token>@<INBOUND_EMAIL_DOMAIN>`.
// The token is an HMAC over the ASSIGNMENT id — not the order id — because an
// assignment identifies order AND florist together, so one opaque value settles
// both questions and the florist binding is re-read from the database rather
// than trusted from the address.
//
// WHY IT IS THIS SHORT: RFC 5321 caps a local-part at 64 octets. `r+` plus a
// 22-char payload plus `.` plus a 22-char signature is 47 — comfortably inside
// it, with room for the prefix to change. A full 32-byte signature would not
// fit, so it is truncated to 128 bits. That is the right trade here: forging a
// token buys an attacker the ability to file a message against a thread they
// must ALSO be able to send email for, and the florist is still matched by
// sender address, never by the token.
//
// No expiry. A florist replying to a three-month-old order email is answering
// about a real order, and an expired token would silently downgrade that to
// "unmatched" — losing the one signal we built this for.
//
// Alias-free (relative imports only) so plain `node --test` can reach it, the
// same constraint lib/recruitingContent.ts and lib/cxAgent.ts carry.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Local-part prefix. Anything not starting with this is not ours. */
export const REPLY_PREFIX = "r+";

const SIG_BYTES = 16;

function secret(): string | null {
  return process.env.REPLY_TOKEN_SECRET || process.env.OUTBOX_SECRET || null;
}

/** UUID → 16 raw bytes. Returns null for anything that isn't one, so a caller
 * that has been handed a name or an empty string mints no token at all rather
 * than a token for the wrong thing. */
export function uuidToBytes(uuid: string): Buffer | null {
  const hex = String(uuid ?? "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

export function bytesToUuid(buf: Buffer): string | null {
  if (buf.length !== 16) return null;
  const h = buf.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sign(payload: Buffer, s: string): string {
  return createHmac("sha256", s).update(payload).digest().subarray(0, SIG_BYTES).toString("base64url");
}

/**
 * What a token stands for. An assignment (order mail) or a florist (recruiting
 * mail, where no assignment exists yet).
 *
 * WIRE FORMAT: an assignment token's payload is the bare 16-byte uuid, exactly
 * as before florist tokens existed, so every order email already in an inbox
 * still verifies. A florist token's payload is one kind byte followed by the
 * uuid. The signature covers the kind byte, so neither kind can be relabelled
 * as the other. 17 bytes is 23 base64url chars, and `r+` + 23 + `.` + 22 is 48
 * octets, still inside the 64-octet local-part limit. There is no room for a
 * conversation id as well (that would be 69), and none is needed: the florist's
 * open recruiting thread is found from the florist (lib/conversations.ts).
 */
export type ReplyTarget = { kind: "assignment"; id: string } | { kind: "florist"; id: string };

const FLORIST_KIND = 0x01;

function payloadFor(target: ReplyTarget): Buffer | null {
  const bytes = uuidToBytes(target.id);
  if (!bytes) return null;
  return target.kind === "assignment" ? bytes : Buffer.concat([Buffer.from([FLORIST_KIND]), bytes]);
}

function targetOf(payload: Buffer): ReplyTarget | null {
  if (payload.length === 16) return { kind: "assignment", id: bytesToUuid(payload)! };
  if (payload.length === 17 && payload[0] === FLORIST_KIND) {
    return { kind: "florist", id: bytesToUuid(payload.subarray(1))! };
  }
  return null;
}

/** Mint a token, or null when unconfigured or handed a non-uuid. */
export function signReplyTarget(target: ReplyTarget): string | null {
  const s = secret();
  if (!s) return null;
  const payload = payloadFor(target);
  if (!payload) return null;
  return `${payload.toString("base64url")}.${sign(payload, s)}`;
}

/** What a token stands for, or null if it is malformed, unsigned, signed with a
 * different secret, or of a kind this code does not know. */
export function verifyReplyTarget(token: string | null | undefined): ReplyTarget | null {
  const s = secret();
  if (!s) return null;
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2) return null;

  const payload = Buffer.from(parts[0], "base64url");
  const target = targetOf(payload);
  if (!target) return null;

  const got = Buffer.from(parts[1]);
  const want = Buffer.from(sign(payload, s));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  return target;
}

/**
 * Mint the token for one assignment, or null when unconfigured or handed a
 * non-uuid. Null is a first-class answer: with no secret set the order email
 * simply ships with the persona reply-to it uses today, and matching falls back
 * to header threading. Nothing breaks while DNS is still being arranged.
 */
export function signReplyToken(assignmentId: string): string | null {
  return signReplyTarget({ kind: "assignment", id: assignmentId });
}

/** The assignment id a token stands for, or null for anything else, a florist
 * token included. */
export function verifyReplyToken(token: string | null | undefined): string | null {
  const target = verifyReplyTarget(token);
  return target?.kind === "assignment" ? target.id : null;
}

function addressFor(target: ReplyTarget, domain?: string | null): string | null {
  const d = (domain ?? process.env.INBOUND_EMAIL_DOMAIN ?? "").trim().replace(/^@/, "");
  if (!d) return null;
  const token = signReplyTarget(target);
  if (!token) return null;
  return `${REPLY_PREFIX}${token}@${d}`;
}

/**
 * The full Reply-To address for an order email, or null if unconfigured.
 *
 * Deliberately null rather than throwing when INBOUND_EMAIL_DOMAIN is unset:
 * until the MX record for that domain exists, a reply sent to it would bounce,
 * and bouncing a florist's reply is far worse than not matching it to an order.
 */
export function replyToAddress(assignmentId: string, domain?: string | null): string | null {
  return addressFor({ kind: "assignment", id: assignmentId }, domain);
}

/**
 * The Reply-To address for recruiting mail: same domain, same prefix, same
 * secret as order mail, but naming the florist. Null when unconfigured, for the
 * same reason as replyToAddress.
 *
 * WHY: recruiting mail used to carry the persona's inbox as Reply-To, so a
 * prospect's reply was identified only by their From address or by threading
 * headers. A prospect replying from another address with a client that dropped
 * In-Reply-To (a webmail quick reply, a forward-then-reply) had nothing left,
 * and 87 such recruiting replies escalated as "unmatched-sender" (factory card
 * 92e8d9e4). The address itself now says who they are.
 */
export function floristReplyAddress(floristId: string, domain?: string | null): string | null {
  return addressFor({ kind: "florist", id: floristId }, domain);
}

/** Pull the token back out of a recipient address. Case-insensitive on the
 * local-part prefix and the domain; the token itself is base64url and IS
 * case-sensitive, so it is never lowercased. */
export function tokenFromAddress(address: string | null | undefined): string | null {
  const addr = String(address ?? "").trim();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  const local = addr.slice(0, at);
  if (local.slice(0, REPLY_PREFIX.length).toLowerCase() !== REPLY_PREFIX) return null;
  const token = local.slice(REPLY_PREFIX.length);
  return token.length > 0 ? token : null;
}

/**
 * Which Reply-To an outbound email carries, best first:
 *
 *   1. `explicit` — a caller that names its own inbox (the outreach persona)
 *      always wins.
 *   2. `tokenAddress` — the signed `r+<token>@INBOUND_EMAIL_DOMAIN` address,
 *      when inbound mail is configured. A reply there is matched back to the
 *      exact order and florist.
 *   3. `fallback` — a real, monitored inbox (app_settings.florist_support_email)
 *      for when (2) is not configured.
 *
 * WHY (3) EXISTS: with no Reply-To at all a reply goes to the From address, and
 * the Resend From address on fc.example.net can send but has no mailbox. Until
 * 2026-09-16 that was every florist reply to an offer: on order #2000034 a
 * French florist asked which button to press 43 minutes before the offer
 * expired, the message bounced back to him, and nobody here saw it for five
 * days. A reply that lands in a shared inbox unmatched is far better than one
 * that bounces. (2) still takes over automatically the day the MX exists.
 *
 * Returns undefined, not null, when nothing applies, so it can be passed
 * straight through to a payload builder that omits an absent key.
 */
export function chooseReplyTo(...candidates: (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const v = (candidate ?? "").trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * The general inbound address for florist mail that is NOT about one
 * assignment: a magic link, or an issue email sent without one.
 *
 * WHY: until 2026-09-16 only order emails could carry a reply address that
 * reaches the app, so a florist replying to a sign-in link or a general notice
 * had nowhere to write that anyone in the backoffice would see. With this, every
 * florist email lands in /conversations. The sender address, or the threading
 * headers of the email being answered (lib/inboundMatch.ts), identifies the
 * florist; there is simply no order to attach.
 *
 * Null when INBOUND_EMAIL_DOMAIN is unset, for the same reason as
 * replyToAddress: until the domain receives mail, a reply sent to it bounces.
 * The local part deliberately does not start with REPLY_PREFIX, so it can never
 * be mistaken for a signed token.
 */
export function inboundMailbox(domain?: string | null): string | null {
  const d = (domain ?? process.env.INBOUND_EMAIL_DOMAIN ?? "").trim().replace(/^@/, "");
  return d ? `florists@${d}` : null;
}
