// Which order is this inbound email about?
//
// Ordered, deterministic, and it never guesses:
//
//   1. REPLY-ADDRESS TOKEN — the florist replied to r+<token>@<inbound domain>,
//      which we minted for exactly one assignment. Exact by construction.
//   2. HEADER THREADING — In-Reply-To / References name a Message-ID we set on
//      an outbound email, and communications already knows that email's order.
//   3. FLORIST TOKEN — the reply went to r+<token>@<inbound domain> minted for a
//      florist on recruiting mail. Names who wrote, never an order. Then header
//      threading to a florist-only email, for mail sent before florist tokens.
//   4. NOTHING — the message attaches to the florist with no order and goes to
//      a human.
//
// There is deliberately NO fourth step reading the subject or the body. A
// florist with three live orders writing "the address is wrong" is not telling
// us which one, and attaching their message to the wrong order puts one shop's
// words on another shop's job. Unattached-and-escalated is a worse inbox; wrong
// is a worse product.
//
// The parsing and the decision are pure and unit-tested; the two lookups they
// need are the only I/O, and they live at the bottom.
//
// Alias-free (relative imports only) so plain `node --test` can reach it.

import { randomUUID } from "node:crypto";
import { tokenFromAddress, verifyReplyTarget } from "./replyToken.ts";

// ---------------------------------------------------------------- outbound --

/**
 * Mint the RFC 5322 Message-ID we set on an outbound email and store in
 * communications.rfc_message_id.
 *
 * We set our own rather than reading back Resend's: their `id` is an opaque
 * API identifier and I have not verified it is the header a mail client echoes
 * into In-Reply-To. Setting it ourselves makes step 2 above depend on nothing
 * we cannot see.
 */
export function newRfcMessageId(domain?: string | null): string {
  const d = (domain ?? process.env.INBOUND_EMAIL_DOMAIN ?? "fc.example.com").trim().replace(/^@/, "");
  return `<fc.${randomUUID()}@${d}>`;
}

// ----------------------------------------------------------------- parsing --

export interface InboundHeadersLike {
  "in-reply-to"?: string | null;
  references?: string | null;
  [k: string]: unknown;
}

export interface MatchKeys {
  /** From a verified reply-address token. Trustworthy on its own. */
  assignmentId: string | null;
  /** From a verified florist reply token (recruiting mail). Names the florist,
   * never an order. */
  floristId: string | null;
  /** Message-IDs this reply claims to answer, most likely first. */
  messageIds: string[];
}

/** Every `<...>` in a header value, in order. Mail clients separate References
 * with whitespace, but folded headers and stray commas both occur in the wild,
 * so this reads the angle brackets rather than trying to split. */
export function parseMessageIds(value: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(value ?? "").matchAll(/<[^<>\s]+>/g)) out.push(m[0]);
  return out;
}

function headerValue(headers: InboundHeadersLike | null | undefined, name: string): string | null {
  if (!headers) return null;
  // Header names are case-insensitive and providers disagree about casing.
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name && typeof v === "string") return v;
  }
  return null;
}

export interface ExtractInput {
  /** Every address the message was sent to, including Cc — the token can be on
   * any of them once a thread has been forwarded around a shop. */
  toAddresses: (string | null | undefined)[];
  headers?: InboundHeadersLike | null;
}

/**
 * Pull both match keys out of a raw inbound message. Pure.
 *
 * References is reversed because it runs oldest-to-newest and the message being
 * answered is the newest one — checking it in file order would preferentially
 * match the FIRST email of a long thread, which for a florist who has had three
 * orders in one thread is the oldest and least relevant.
 */
export function extractMatchKeys(input: ExtractInput): MatchKeys {
  let assignmentId: string | null = null;
  let floristId: string | null = null;
  for (const addr of input.toAddresses ?? []) {
    const target = verifyReplyTarget(tokenFromAddress(addr));
    if (target?.kind === "assignment") assignmentId ??= target.id;
    if (target?.kind === "florist") floristId ??= target.id;
  }

  const inReplyTo = parseMessageIds(headerValue(input.headers, "in-reply-to"));
  const references = parseMessageIds(headerValue(input.headers, "references")).reverse();

  // In-Reply-To names the single message being answered, so it outranks the
  // whole References chain. Deduped, order preserved.
  const messageIds = [...new Set([...inReplyTo, ...references])];

  return { assignmentId, floristId, messageIds };
}

// ---------------------------------------------------------------- decision --

export type MatchSource = "reply-token" | "header-thread" | "reply-token-florist" | "header-thread-florist" | "none";

export interface MatchResult {
  orderId: string | null;
  assignmentId: string | null;
  /** The florist the MATCH implies. The caller must reconcile this with the
   * florist implied by the sender address — see mismatch handling below. */
  floristId: string | null;
  source: MatchSource;
}

export interface AssignmentRow {
  id: string;
  order_id: string | null;
  florist_id: string | null;
}

/** The local-part of a Message-ID: `<fc.abc@mail.x>` → `fc.abc`, with our own
 * `fc.` prefix dropped so the remainder can be compared against a provider id.
 * Belt and braces for the case where Resend substitutes its own Message-ID for
 * the one we set — then the header still names Resend's id, and Resend's id is
 * what provider_message_id holds. */
export function messageIdLocalPart(messageId: string): string {
  const inner = messageId.replace(/^</, "").replace(/>$/, "");
  const at = inner.lastIndexOf("@");
  const local = at > 0 ? inner.slice(0, at) : inner;
  return local.startsWith("fc.") ? local.slice(3) : local;
}

export interface CommunicationRow {
  rfc_message_id: string | null;
  provider_message_id?: string | null;
  order_id: string | null;
  florist_id: string | null;
  assignment_id: string | null;
}

/**
 * Decide, given the keys and the rows they resolved to. Pure.
 *
 * `senderFloristId` is who the FROM address says this is. When a match names a
 * different florist the match is discarded, not preferred: that combination
 * means a thread was forwarded between shops, and the one thing we must not do
 * is show shop A's message on shop B's order. It degrades to no-order, which
 * escalates.
 */
export function pickMatch(
  keys: MatchKeys,
  rows: { assignment?: AssignmentRow | null; communications?: CommunicationRow[] | null },
  senderFloristId: string | null
): MatchResult {
  const none: MatchResult = { orderId: null, assignmentId: null, floristId: null, source: "none" };

  // A florist token is our own signed word for who this is, so it guards the
  // header passes the way a recognised sender does.
  const known = senderFloristId ?? keys.floristId;
  const agrees = (floristId: string | null): boolean => !known || !floristId || known === floristId;

  const a = rows.assignment;
  if (keys.assignmentId && a && a.id === keys.assignmentId && agrees(a.florist_id)) {
    return {
      orderId: a.order_id,
      assignmentId: a.id,
      floristId: a.florist_id,
      source: "reply-token",
    };
  }

  // Message-IDs in priority order; the first one we actually sent wins.
  const comms = rows.communications ?? [];
  const byHeader = new Map(comms.filter((c) => c.rfc_message_id).map((c) => [c.rfc_message_id, c]));
  const byProvider = new Map(comms.filter((c) => c.provider_message_id).map((c) => [c.provider_message_id, c]));
  for (const id of keys.messageIds) {
    const c = byHeader.get(id) ?? byProvider.get(messageIdLocalPart(id));
    if (!c || !c.order_id) continue;
    if (!agrees(c.florist_id)) continue;
    return {
      orderId: c.order_id,
      assignmentId: c.assignment_id ?? null,
      floristId: c.florist_id,
      source: "header-thread",
    };
  }

  // A reply to a recruiting email, by the signed florist address it was sent
  // to. Needs no header at all, which is the point: a prospect's first reply is
  // the one most likely to come from a client that dropped them. It names the
  // florist only, and an order-bearing match above always wins.
  if (keys.floristId && agrees(keys.floristId)) {
    return { orderId: null, assignmentId: null, floristId: keys.floristId, source: "reply-token-florist" };
  }

  // Second pass: a reply to an email that was about a FLORIST but no order (a
  // magic link, a recruiting touch). It still tells us who wrote, which matters
  // when they reply from an address we do not recognise, so the message lands
  // on their thread instead of escalating as "unmatched sender". It never
  // invents an order, and an order-bearing match above always wins. The same
  // forwarded-thread guard applies: a different sender discards it.
  for (const id of keys.messageIds) {
    const c = byHeader.get(id) ?? byProvider.get(messageIdLocalPart(id));
    if (!c || c.order_id || !c.florist_id) continue;
    if (!agrees(c.florist_id)) continue;
    return { orderId: null, assignmentId: null, floristId: c.florist_id, source: "header-thread-florist" };
  }

  return none;
}

/**
 * Which assistant owns an inbound thread. Pure.
 *
 * A reply ABOUT AN ORDER is support, whether or not the florist has formally
 * joined. Until 2026-09-16 only `joined_at` decided, so a shop that received a
 * cold offer and wrote back asking how to accept it — exactly order #2000034 —
 * would have been answered by the recruiting assistant with a pitch to join.
 * The /conversations page describes support as "shops in the network asking
 * about an order they are holding"; being offered the order is holding it.
 * With no order, joining still decides.
 */
export function threadKind(input: { orderId: string | null; joined: boolean }): "support" | "recruiting" {
  return input.orderId || input.joined ? "support" : "recruiting";
}

// ---------------------------------------------------------------------- IO --

/** The service-role client, structurally.
 *
 * Typed loosely on purpose. This module is alias-free so plain `node --test`
 * can reach the pure functions above, which rules out importing the real
 * SupabaseClient type — that import would drag the client into the test
 * process. Modelling PostgREST's builder by hand was worse: it does not type
 * check against the real thing, and a hand-written approximation that disagrees
 * with reality is a liability rather than a safety net. The call sites below
 * are three fixed queries, and the compiler still checks the SHAPES they
 * return via the row interfaces. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Queryable = { from: (table: string) => any };

/**
 * Resolve the keys against the database. Two queries at most, and only the ones
 * the keys call for — an inbound with neither a token nor a threading header
 * hits the database not at all.
 */
export async function matchInboundOrder(
  admin: Queryable,
  input: ExtractInput,
  senderFloristId: string | null
): Promise<MatchResult> {
  const keys = extractMatchKeys(input);
  if (!keys.assignmentId && keys.messageIds.length === 0) {
    return pickMatch(keys, {}, senderFloristId);
  }

  let assignment: AssignmentRow | null = null;
  if (keys.assignmentId) {
    const { data } = await admin
      .from("order_assignments")
      .select("id, order_id, florist_id")
      .eq("id", keys.assignmentId)
      .maybeSingle();
    assignment = (data as AssignmentRow) ?? null;
  }

  let communications: CommunicationRow[] = [];
  if (keys.messageIds.length > 0) {
    const cols = "rfc_message_id, provider_message_id, order_id, florist_id, assignment_id";
    // Two lookups, because a reply's In-Reply-To may name either the header we
    // set or the one Resend substituted for it. Both are cheap indexed `in`
    // queries over at most a handful of ids.
    const [byHeader, byProvider] = await Promise.all([
      admin.from("communications").select(cols).in("rfc_message_id", keys.messageIds),
      admin.from("communications").select(cols).in("provider_message_id", keys.messageIds.map(messageIdLocalPart)),
    ]);
    const seen = new Set<string>();
    communications = [
      ...((byHeader.data as CommunicationRow[]) ?? []),
      ...((byProvider.data as CommunicationRow[]) ?? []),
    ].filter((c) => {
      const key = `${c.rfc_message_id ?? ""}|${c.provider_message_id ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return pickMatch(keys, { assignment, communications }, senderFloristId);
}
