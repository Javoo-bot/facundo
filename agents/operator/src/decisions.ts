// What the operator sees and what each answer does. Pure: no fetch, no env, so
// decisions.test.ts covers every branch.
//
// A grey decision is one of two things the garden already parks for a person:
//   conversation  the support or recruiting agent drafted a reply and held it
//                 (conversations.status = 'awaiting_human', the draft kept as a
//                 conversation_messages row with status 'draft')
//   approval      a semi-auto step waiting for a yes (order_approvals.status = 'pending')

import { ESCALATION_REASON_LABEL } from "../../../dashboard/lib/conversationReasons";

export type Source = "conversation" | "approval";
export type Action = "approve_draft" | "send_my_reply" | "reject" | "escalate_to_owner";
export const ACTIONS: readonly Action[] = ["approve_draft", "send_my_reply", "reject", "escalate_to_owner"];

export interface Decision {
  /** What the operator passes back to decide(): "c-<uuid>" or "a-<uuid>". */
  id: string;
  source: Source;
  sourceId: string;
  orderId: string | null;
  orderName: string | null;
  /** Who is waiting on the answer, in words. */
  waiting: string;
  /** Who reads what gets sent. The relay rule only bites for florists. */
  audience: "florist" | "client" | "nobody";
  /** What happened, in one or two sentences. */
  what: string;
  /** The agent's held reply or the email the step would send. Null when there is none. */
  draft: string | null;
  draftSubject: string | null;
  /** Why the agent stopped, in plain words. */
  why: string;
  /** Which agent or step produced it: concierge, cupid, or step:<kind>. */
  agent: string;
  since: string;
  /** Set when the operator already passed it to the owner; it then leaves the operator's list. */
  withOwner: boolean;
  aiContext: unknown;
}

// ---- ids ---------------------------------------------------------------------

const PREFIX: Record<Source, string> = { conversation: "c-", approval: "a-" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decisionId(source: Source, sourceId: string): string {
  return PREFIX[source] + sourceId;
}

export function parseDecisionId(id: string): { source: Source; sourceId: string } | null {
  const trimmed = id.trim();
  const source = trimmed.startsWith("c-") ? "conversation" : trimmed.startsWith("a-") ? "approval" : null;
  const sourceId = trimmed.slice(2);
  return source && UUID.test(sourceId) ? { source, sourceId } : null;
}

// ---- rows in, decisions out ----------------------------------------------------

export interface ConversationRow {
  id: string;
  kind: "support" | "recruiting";
  channel: string;
  escalation_reason: string | null;
  escalated_at: string | null;
  order_id: string | null;
  florists: { name: string | null } | null;
  orders: { order_name: string | null } | null;
  conversation_messages: Array<{
    direction: "in" | "out";
    status: string | null;
    body_text: string | null;
    subject: string | null;
    created_at: string;
    ai_context: unknown;
  }>;
}

export interface ApprovalRow {
  id: string;
  kind: string;
  order_id: string;
  draft_subject: string | null;
  draft_body: string | null;
  preview: unknown;
  block_reason: string | null;
  created_at: string;
  orders: { order_name: string | null } | null;
}

export function reasonInWords(reason: string | null): string {
  if (!reason) return "The agent handed this to a person";
  return ESCALATION_REASON_LABEL[reason] ?? ESCALATION_REASON_LABEL[reason.replace(/_/g, "-")] ?? `The agent stopped (${reason})`;
}

const STEP_WORDS: Record<string, { what: string; audience: Decision["audience"] }> = {
  match: { what: "Pick florists for this order", audience: "nobody" },
  offer: { what: "Send this order offer to a florist", audience: "florist" },
  reassign: { what: "Move this order to another florist", audience: "nobody" },
  escalate: { what: "Nobody could take this order; hand it to the team", audience: "nobody" },
  writeback: { what: "Write the order's progress back to the shop", audience: "nobody" },
  client_assigned: { what: "Tell the client a florist has the order", audience: "client" },
  client_on_the_way: { what: "Tell the client the flowers are on the way", audience: "client" },
  client_delivered: { what: "Tell the client the flowers were delivered", audience: "client" },
  chase_photo: { what: "Ask the florist for the delivery photo", audience: "florist" },
};

const EMAIL_STEPS = new Set(["offer", "client_assigned", "client_on_the_way", "client_delivered"]);

function oneLine(text: string | null | undefined, max = 280): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function fromConversation(row: ConversationRow, withOwner: boolean): Decision {
  const msgs = [...row.conversation_messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lastIn = [...msgs].reverse().find((m) => m.direction === "in");
  const draft = [...msgs].reverse().find((m) => m.status === "draft");
  const shop = row.florists?.name ?? "A florist";
  return {
    id: decisionId("conversation", row.id),
    source: "conversation",
    sourceId: row.id,
    orderId: row.order_id,
    orderName: row.orders?.order_name ?? null,
    waiting: `${shop} (florist${row.kind === "recruiting" ? " we are signing up" : ""})`,
    audience: "florist",
    what: lastIn ? `They wrote: "${oneLine(lastIn.body_text)}"` : "A thread is waiting for a person.",
    draft: draft?.body_text ?? null,
    draftSubject: draft?.subject ?? null,
    why: reasonInWords(row.escalation_reason),
    agent: row.kind === "support" ? "concierge" : "cupid",
    since: row.escalated_at ?? lastIn?.created_at ?? "",
    withOwner,
    aiContext: draft?.ai_context ?? null,
  };
}

export function fromApproval(row: ApprovalRow, withOwner: boolean): Decision {
  const step = STEP_WORDS[row.kind] ?? { what: `Approve the step "${row.kind}"`, audience: "nobody" as const };
  const previewReason =
    row.preview && typeof row.preview === "object" && "reason" in row.preview ? String((row.preview as { reason: unknown }).reason) : null;
  return {
    id: decisionId("approval", row.id),
    source: "approval",
    sourceId: row.id,
    orderId: row.order_id,
    orderName: row.orders?.order_name ?? null,
    waiting: step.audience === "client" ? "The client" : step.audience === "florist" ? "The florist" : "The order",
    audience: step.audience,
    what: step.what,
    draft: row.draft_body,
    draftSubject: row.draft_subject,
    why: previewReason ?? row.block_reason ?? "This step waits for a person's yes (semi-auto mode)",
    agent: `step:${row.kind}`,
    since: row.created_at,
    withOwner,
    aiContext: null,
  };
}

// ---- the relay rule ------------------------------------------------------------

// The florist never sees what the client paid or was refunded, only what to do.
// A figure with a currency, or talk of refunds, does not go to a florist.
const MONEY = /(?:[€$£]\s?\d)|(?:\b(?:eur|usd|gbp|chf)\s?\d)|(?:\d[\d.,]*\s?(?:€|eur\b|euros?\b|usd\b|gbp\b|chf\b|\$|£))/i;
const REFUND = /\b(refund\w*|reembols\w*|rembours\w*|erstatt\w*|r[üu]ckerstatt\w*|rimbors\w*|terugbetal\w*)/i;

export function relayProblem(text: string): string | null {
  if (MONEY.test(text)) return "It mentions an amount of money. The florist never sees what the client paid; say only what to do, and point them to their app for their own payout.";
  if (REFUND.test(text)) return "It talks about a refund. Refunds stay between the team and the client; tell the florist only what to do.";
  return null;
}

// ---- what an answer does -------------------------------------------------------

export type Plan =
  | { kind: "refuse"; why: string }
  | { kind: "reply"; conversationId: string; text: string }
  | { kind: "close"; conversationId: string }
  | { kind: "approve"; approvalId: string; edits?: { subject?: string; body: string } }
  | { kind: "reject"; approvalId: string; reason: string }
  | { kind: "to_owner" };

export interface DecideInput {
  action: Action;
  text?: string;
  note?: string;
}

export function finalText(d: Decision, input: DecideInput): string | null {
  if (input.action === "approve_draft") return d.draft;
  if (input.action === "send_my_reply") return input.text?.trim() || null;
  return null;
}

export function planDecision(d: Decision, input: DecideInput): Plan {
  if (d.withOwner && input.action !== "escalate_to_owner") {
    return { kind: "refuse", why: "This one is already with the owner. Leave it to him." };
  }
  if (input.action === "escalate_to_owner") return { kind: "to_owner" };

  if (input.action === "reject") {
    return d.source === "conversation"
      ? { kind: "close", conversationId: d.sourceId }
      : { kind: "reject", approvalId: d.sourceId, reason: input.note?.trim() || "Rejected by the operator" };
  }

  const text = finalText(d, input);
  if (input.action === "approve_draft" && d.source === "conversation" && !text) {
    return { kind: "refuse", why: "The agent left no draft here. Use send_my_reply with your own words." };
  }
  if (input.action === "send_my_reply" && !text) {
    return { kind: "refuse", why: "send_my_reply needs the text to send." };
  }
  if (input.action === "send_my_reply" && d.source === "approval" && !EMAIL_STEPS.has(d.agent.slice(5))) {
    return { kind: "refuse", why: "This step sends no message you can rewrite. Use approve_draft to say yes, or reject." };
  }
  // A step's own email is the product's template (an offer shows the florist
  // their own payout, which is theirs to see), so approving it unchanged is not
  // checked. Anything a person or an agent wrote for a florist is.
  const templateAsIs = d.source === "approval" && input.action === "approve_draft";
  if (text && d.audience === "florist" && !templateAsIs) {
    const problem = relayProblem(text);
    if (problem) return { kind: "refuse", why: `Not sent. ${problem}` };
  }

  if (d.source === "conversation") return { kind: "reply", conversationId: d.sourceId, text: text! };
  return input.action === "send_my_reply"
    ? { kind: "approve", approvalId: d.sourceId, edits: { subject: d.draftSubject ?? undefined, body: text! } }
    : { kind: "approve", approvalId: d.sourceId };
}

// ---- the morning email ---------------------------------------------------------

export const PROJECT_URL = "https://claude.ai/project/<your-project-id>";

export function digestLine(d: Decision): string {
  const order = d.orderName ? `${d.orderName} · ` : "";
  const why = d.why.replace(/[.\s]+$/, "");
  return `${order}${d.waiting}: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`;
}

const DIGEST_MAX = 15;

export function renderDigest(open: Decision[], withOwner: Decision[], day: string): { subject: string; text: string } {
  const n = open.length;
  const subject = n === 0 ? `Garden ${day}: nothing waiting for you` : `Garden ${day}: ${n} decision${n === 1 ? "" : "s"} waiting`;
  const lines = [
    n === 0 ? "Good morning. Nothing in the garden needs you today." : `Good morning. ${n} thing${n === 1 ? "" : "s"} in the garden need${n === 1 ? "s" : ""} you:`,
    "",
    ...open.slice(0, DIGEST_MAX).map((d) => `- ${digestLine(d)}`),
  ];
  if (n > DIGEST_MAX) lines.push(`- and ${n - DIGEST_MAX} more.`);
  if (withOwner.length) lines.push("", `${withOwner.length} more ${withOwner.length === 1 ? "is" : "are"} with the owner.`);
  if (n) lines.push("", `Open the project and say "what's waiting?": ${PROJECT_URL}`);
  return { subject, text: lines.join("\n") };
}

/** The cron fires at 04:45 and 05:45 UTC; only the one that is 06:45 in Madrid sends. */
export function isDigestTime(at: Date): boolean {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(at);
  return hour === "06";
}

export function madridDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(at);
}
