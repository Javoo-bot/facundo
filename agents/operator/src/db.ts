// Reads from the garden database (PostgREST, service role), and the one table
// this worker writes itself: operator_decisions. Conversations and approvals are
// only ever changed through the dashboard (dashboard.ts).

import { gardenEnv, type Env } from "./garden";
import {
  fromApproval,
  fromConversation,
  type Action,
  type ApprovalRow,
  type ConversationRow,
  type Decision,
  type Source,
} from "./decisions";

async function rest<T>(env: Env, path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<T> {
  const key = gardenEnv(env).SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.prefer ? { prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const CONVERSATION_SELECT =
  "id,kind,channel,status,escalation_reason,escalated_at,order_id,florists(name),orders(order_name)," +
  "conversation_messages(direction,status,body_text,subject,created_at,ai_context)";
const APPROVAL_SELECT = "id,kind,status,order_id,draft_subject,draft_body,preview,block_reason,created_at,orders(order_name)";

async function withOwnerIds(env: Env, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await rest<Array<{ source_id: string }>>(
    env,
    `operator_decisions?action=eq.escalate_to_owner&source_id=in.(${ids.join(",")})&select=source_id`,
  );
  return new Set(rows.map((r) => r.source_id));
}

/** Everything still waiting that was parked in the last `hours`, newest first. */
export async function openDecisions(env: Env, hours: number): Promise<Decision[]> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const [convos, approvals] = await Promise.all([
    rest<ConversationRow[]>(
      env,
      `conversations?status=eq.awaiting_human&escalated_at=gte.${since}&select=${CONVERSATION_SELECT}&order=escalated_at.desc&limit=100`,
    ),
    rest<ApprovalRow[]>(env, `order_approvals?status=eq.pending&created_at=gte.${since}&select=${APPROVAL_SELECT}&order=created_at.desc&limit=100`),
  ]);
  const owner = await withOwnerIds(env, [...convos.map((c) => c.id), ...approvals.map((a) => a.id)]);
  return [
    ...convos.map((c) => fromConversation(c, owner.has(c.id))),
    ...approvals.map((a) => fromApproval(a, owner.has(a.id))),
  ].sort((a, b) => b.since.localeCompare(a.since));
}

export interface Loaded {
  decision: Decision;
  /** False once someone (a person in the dashboard, or an earlier decide) has handled it. */
  open: boolean;
}

export async function loadDecision(env: Env, source: Source, id: string): Promise<Loaded | null> {
  if (source === "conversation") {
    const [row] = await rest<Array<ConversationRow & { status: string }>>(env, `conversations?id=eq.${id}&select=${CONVERSATION_SELECT}`);
    if (!row) return null;
    const owner = await withOwnerIds(env, [id]);
    return { decision: fromConversation(row, owner.has(id)), open: row.status === "awaiting_human" };
  }
  const [row] = await rest<Array<ApprovalRow & { status: string }>>(env, `order_approvals?id=eq.${id}&select=${APPROVAL_SELECT}`);
  if (!row) return null;
  const owner = await withOwnerIds(env, [id]);
  return { decision: fromApproval(row, owner.has(id)), open: row.status === "pending" };
}

export async function thread(env: Env, conversationId: string) {
  return rest<Array<{ direction: string; status: string; body_text: string | null; created_at: string; actor: string | null; ai_generated: boolean }>>(
    env,
    `conversation_messages?conversation_id=eq.${conversationId}&select=direction,status,body_text,created_at,actor,ai_generated&order=created_at.asc`,
  );
}

export async function order(env: Env, orderId: string) {
  const [row] = await rest<Array<Record<string, unknown>>>(
    env,
    `orders?id=eq.${orderId}&select=order_name,status,delivery_at,delivery_window,delivery_area,delivery_address,occasion,greeting,substitution_policy,total,currency,escalation_reason`,
  );
  return row ?? null;
}

export interface DecisionRecord {
  decision: Decision;
  action: Action;
  finalText: string | null;
  note: string | null;
  operator: string;
}

export async function record(env: Env, r: DecisionRecord): Promise<void> {
  await rest(env, "operator_decisions", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      decision_ref: r.decision.id,
      source: r.decision.source,
      source_id: r.decision.sourceId,
      order_id: r.decision.orderId,
      agent: r.decision.agent,
      why_stopped: r.decision.why,
      action: r.action,
      agent_draft: r.decision.draft,
      final_text: r.finalText,
      note: r.note,
      operator: r.operator,
      acted_as: env.OPERATOR_EMAIL,
      ai_context: r.decision.aiContext,
    },
  });
}

export async function decisionsToday(env: Env, sinceIso: string) {
  return rest<Array<{ action: string; agent: string | null; decided_at: string }>>(
    env,
    `operator_decisions?decided_at=gte.${sinceIso}&select=action,agent,decided_at`,
  );
}
