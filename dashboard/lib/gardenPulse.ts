// The Garden pulse page's data shapes, as pure functions: rows in, what the
// page shows out. Relative imports only, so `node --test` and the factory
// sweep (agents/factory/cards.mjs) can both import it.
//
// The owner steers the garden from aggregates, never single cases: a case only
// appears here as one of a cluster's two or three examples.

import type { OrderStatus } from "./orderStatus.ts";

const MADRID = "Europe/Madrid";

/** Midnight in Madrid today, as an ISO instant. */
export function madridDayStart(now: Date = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: MADRID, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const noonUtc = new Date(`${day}T12:00:00Z`);
  const madridNoon = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", hour12: false }).format(noonUtc);
  const offsetHours = Number(madridNoon) - 12;
  return new Date(Date.parse(`${day}T00:00:00Z`) - offsetHours * 3_600_000).toISOString();
}

// ---- today's load -----------------------------------------------------------

type LoadBucket = "handled" | "waiting" | "escalated" | "cancelled";

const BUCKET: Record<OrderStatus, LoadBucket> = {
  received: "waiting",
  matched: "waiting",
  reaching_out: "waiting",
  accepted: "handled",
  in_production: "handled",
  ready: "handled",
  out_for_delivery: "handled",
  delivered: "handled",
  paid: "handled",
  closed: "handled",
  escalated: "escalated",
  cancelled: "cancelled",
};

export interface TodayLoad {
  planted: number;
  /** A florist took it, with no person involved in getting there. */
  handled: number;
  /** Still looking for a florist. */
  waiting: number;
  escalated: number;
  cancelled: number;
}

/** The statuses of the orders planted today, counted into the four buckets. */
export function todayLoad(statuses: readonly string[]): TodayLoad {
  const load: TodayLoad = { planted: statuses.length, handled: 0, waiting: 0, escalated: 0, cancelled: 0 };
  for (const s of statuses) load[BUCKET[s as OrderStatus] ?? "waiting"]++;
  return load;
}

// ---- AI calls through the garden router ---------------------------------------

/** GET /status on agents/router (src/limits.ts::Snapshot). */
export interface RouterSnapshot {
  day: string;
  keys: Record<string, { minute: number; day: number; coolingUntil: string | null }>;
}

export interface ProviderCalls {
  provider: string;
  today: number;
  /** Set while the router keeps the whole provider out after a 401/402/429. */
  coolingUntil: string | null;
  models: { model: string; today: number; coolingUntil: string | null }[];
}

/** The router counts calls under "provider:<id>" and "<id>/<model>". */
export function callsByProvider(snapshot: RouterSnapshot): ProviderCalls[] {
  const byProvider = new Map<string, ProviderCalls>();
  const get = (provider: string) => {
    let p = byProvider.get(provider);
    if (!p) byProvider.set(provider, (p = { provider, today: 0, coolingUntil: null, models: [] }));
    return p;
  };
  for (const [key, v] of Object.entries(snapshot.keys)) {
    if (key.startsWith("provider:")) {
      const p = get(key.slice("provider:".length));
      p.today = v.day;
      p.coolingUntil = v.coolingUntil;
      continue;
    }
    const slash = key.indexOf("/");
    if (slash < 0) continue;
    get(key.slice(0, slash)).models.push({ model: key.slice(slash + 1), today: v.day, coolingUntil: v.coolingUntil });
  }
  const out = [...byProvider.values()];
  for (const p of out) p.models.sort((a, b) => b.today - a.today);
  return out.sort((a, b) => b.today - a.today || a.provider.localeCompare(b.provider));
}

// ---- agent scorecard ----------------------------------------------------------

/** One row of agent_daily_metrics (agents/monitoring/schema.sql). */
export interface MetricRow {
  day: string;
  agent: string;
  nick: string;
  measure: string;
  position: number;
  means: string;
  decides: boolean;
  cases: number;
  value: number | string | null;
  minimum_text: string;
  percent: boolean;
  status: "ok" | "below minimum" | "not enough cases" | "not measurable yet";
  reason: string | null;
}

export type AgentHealth = "below" | "ok" | "waiting";

export interface AgentScore {
  agent: string;
  nick: string;
  /** below: a deciding measure is under its minimum. ok: every judged deciding
   * measure meets it. waiting: nothing deciding has enough cases yet. */
  health: AgentHealth;
  measures: (MetricRow & { shown: string })[];
}

function shownValue(r: MetricRow): string {
  if (r.value === null || r.value === undefined) return "–";
  const v = Number(r.value);
  return r.percent ? `${Math.round(v * 100)}%` : String(Math.round(v * 100) / 100);
}

/** Today's rows (one day) grouped per agent, worst agents first. */
export function scorecard(rows: readonly MetricRow[]): AgentScore[] {
  const byAgent = new Map<string, AgentScore>();
  for (const r of rows) {
    let a = byAgent.get(r.agent);
    if (!a) byAgent.set(r.agent, (a = { agent: r.agent, nick: r.nick, health: "waiting", measures: [] }));
    a.measures.push({ ...r, shown: shownValue(r) });
  }
  const rank: Record<AgentHealth, number> = { below: 0, ok: 1, waiting: 2 };
  const out = [...byAgent.values()];
  for (const a of out) {
    a.measures.sort((x, y) => x.position - y.position);
    const deciding = a.measures.filter((m) => m.decides);
    if (deciding.some((m) => m.status === "below minimum")) a.health = "below";
    else if (deciding.some((m) => m.status === "ok")) a.health = "ok";
  }
  return out.sort((x, y) => rank[x.health] - rank[y.health] || x.nick.localeCompare(y.nick));
}

// ---- clusters -----------------------------------------------------------------

export type CaseSource = "conversation" | "order" | "rule_gap";

/** One case that ended with a person (or a policy hold), from any source. */
export interface PulseCase {
  source: CaseSource;
  /** The agent whose file owns it, or null for the order loop's own code. */
  agent: string | null;
  reason: string;
  /** Phase 4's planner: the rule it was missing, when it said. */
  ruleGap: string | null;
  at: string | null;
  link: string | null;
}

export interface Cluster {
  key: string;
  source: CaseSource;
  agent: string | null;
  reason: string;
  ruleGap: string | null;
  count: number;
  latestAt: string | null;
  examples: PulseCase[];
}

export const EXAMPLES_PER_CLUSTER = 3;

const norm = (s: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// The rule gap is the planner's own sentence, different every time, so it is
// shown with the cluster but never part of its key.
export const clusterKey = (c: Pick<PulseCase, "source" | "agent" | "reason">) =>
  [c.source, c.agent ?? "-", norm(c.reason)].join("|");

/** Cases with the same source, agent and reason are one cluster, carrying the
 * newest rule gap. Biggest first; each keeps its newest few cases as examples. */
export function clusterCases(cases: readonly PulseCase[], examples = EXAMPLES_PER_CLUSTER): Cluster[] {
  const groups = new Map<string, PulseCase[]>();
  for (const c of cases) {
    const k = clusterKey(c);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const out: Cluster[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
    const first = sorted[0];
    out.push({
      key,
      source: first.source,
      agent: first.agent,
      reason: first.reason,
      ruleGap: sorted.find((c) => c.ruleGap)?.ruleGap ?? null,
      count: list.length,
      latestAt: sorted.find((c) => c.at)?.at ?? null,
      examples: sorted.slice(0, examples),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Which agent answers which kind of conversation (agents/factory/cards.mjs). */
export const CONVERSATION_AGENT: Record<string, string> = { support: "concierge", recruiting: "cupid" };

export function conversationCases(
  rows: readonly { id: string; kind: string; escalation_reason: string | null; escalated_at: string | null; order_id: string | null; florist_id: string | null }[],
): PulseCase[] {
  return rows.map((c) => ({
    source: "conversation",
    agent: CONVERSATION_AGENT[c.kind] ?? null,
    reason: c.escalation_reason ?? "unknown",
    ruleGap: null,
    at: c.escalated_at,
    link: c.order_id ? `/orders/${c.order_id}` : c.florist_id ? `/florists/${c.florist_id}` : "/conversations",
  }));
}

/** garden_order_issues (agents/monitoring/schema.sql): the order loop's own
 * code owns these, so they cluster with no agent. */
export function orderIssueCases(rows: readonly { id: string; issue: string; created_at: string | null }[]): PulseCase[] {
  return rows.map((o) => ({ source: "order", agent: null, reason: o.issue, ruleGap: null, at: o.created_at, link: `/orders/${o.id}` }));
}

/** An agent_events row (Phase 4: case_id, seq, type, data, created_at). */
export interface AgentEventRow {
  case_id: string;
  type: string;
  data: Record<string, unknown> | null;
  created_at?: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** "order:<uuid>" -> the order page; other cases have no page of their own. */
function caseLink(caseId: string): string | null {
  const [kind, id] = caseId.split(":");
  if (kind === "order" && id) return `/orders/${id}`;
  if (kind === "conversation") return "/conversations";
  return null;
}

/** The rule gaps the Phase 4 planner logged. A `rule_gap` event ({gap, step,
 * agent}) is one case; a plan whose `rule_gap` is set counts only when no
 * rule_gap event already records the same gap on the same case. A gap with no
 * agent (written before agents were named on them) is the planner's. The reason is the step the policy held (hand_to_person, refund),
 * the one stable word in a gap; for a model failure it is the error type and
 * the triggering message's fingerprint, so near-identical messages that keep
 * breaking the model are one cluster. */
export function ruleGapCases(rows: readonly AgentEventRow[]): PulseCase[] {
  const out: PulseCase[] = [];
  const seen = new Set<string>();
  const add = (e: AgentEventRow, gap: string | null, step: string | null, agent: string | null) => {
    const k = `${e.case_id}|${norm(gap)}`;
    if (seen.has(k)) return;
    seen.add(k);
    const d = e.data ?? {};
    const failed = str(d.error) && str(d.fingerprint) ? `model failed: ${str(d.error)} on message ${str(d.fingerprint)}` : null;
    out.push({
      source: "rule_gap",
      agent,
      reason: failed ?? step ?? "no step named",
      ruleGap: gap,
      at: e.created_at ?? null,
      link: caseLink(e.case_id),
    });
  };
  for (const e of rows) if (e.type === "rule_gap") add(e, str(e.data?.gap) ?? str(e.data?.rule_gap), str(e.data?.step), str(e.data?.agent) ?? "planner");
  for (const e of rows) {
    const gap = str(e.data?.rule_gap);
    if (e.type !== "rule_gap" && gap) add(e, gap, str(e.data?.chosen), "planner");
  }
  return out;
}
