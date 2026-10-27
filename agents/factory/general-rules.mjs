// The 13 general rules and a card's life. Pure, no I/O: general-rules.test.mjs
// drives it with plain objects and a fake model. The design:
// docs/agent-factory/garden-1.2/README.md sections 1 to 5 (on docs/control-room).
//
// The rules are the branches in dashboard/lib/lifecycle.ts ("situations"),
// grouped under 13 general rules (general-rules.json), each owned by one
// manager. A sweep signal is an alert; it lands on a general rule by an exact
// situation id, else by a Haiku near match. Cards open per general rule, not
// per situation.

import RULES from "./general-rules.json" with { type: "json" };
import { WAITING } from "./questions.mjs";

export { RULES };

/** the owner's numbers (2026-10-27). Change them here and nowhere else. */
export const CARD_LIFE = Object.freeze({
  /** A general rule opens its card at this many alerts... */
  openAlerts: 3,
  /** ...within this many days. */
  openWindowDays: 7,
  /** A card closes once its rule has been quiet this many days after the fix
   * merged. A new alert on a closed rule reopens the same card. */
  quietDays: 7,
});

/** The near-match fallback: Haiku via OpenRouter, capped per Madrid day. Past
 * the cap, alerts wait for the next day rather than being dropped. */
export const NEAR_MATCH = Object.freeze({
  model: "anthropic/claude-haiku-4.5",
  dailyCapUsd: 0.5,
  /** Kept free before each call, so the last call cannot overshoot the cap. */
  reserveUsd: 0.01,
});

export const DAY_MS = 24 * 3600_000;

/** The cast (README section 5). Managers are promoted roles: until each has its
 * own role file, a card's brief is the thinking file its rule names (`agent`
 * in general-rules.json). Jessica is the owner: money stays with a person, so the
 * executor never picks her cards. */
export const MANAGERS = Object.freeze({
  harvey: { name: "Harvey", area: "supply", promotedFrom: "scout" },
  donna: { name: "Donna", area: "order loop", promotedFrom: "concierge" },
  louis: { name: "Louis", area: "proof", promotedFrom: "hawkeye" },
  jessica: { name: "Jessica", area: "money", promotedFrom: null, human: true },
});

/** situation id -> general rule. */
export function ruleIndex(rules = RULES) {
  const index = new Map();
  for (const r of rules) for (const m of r.members) index.set(m, r);
  return index;
}

/**
 * Checks general-rules.json against lifecycle.ts. Every situation sits under
 * exactly one rule, every member is a real situation, every owner a manager,
 * and a situation an agent added says who, when, and from which rule's near
 * matches (`addedBy`, `addedOn`, `fromNear`), and sits under that rule.
 * @param branches every Branch in PHASES and CROSS_CUTTING
 */
export function checkRules(rules, branches) {
  const ids = branches.map((b) => b.id);
  const members = rules.flatMap((r) => r.members);
  const ruleOf = ruleIndex(rules);
  const problems = [];
  for (const id of ids) if (!members.includes(id)) problems.push(`${id} sits under no general rule`);
  for (const id of members) if (!ids.includes(id)) problems.push(`${id} is not a situation in lifecycle.ts`);
  for (const id of new Set(members.filter((m, i) => members.indexOf(m) !== i))) problems.push(`${id} sits under two general rules`);
  for (const r of rules) if (!(r.owner in MANAGERS)) problems.push(`${r.id} has no manager (owner "${r.owner}")`);
  for (const b of branches) {
    if (b.addedBy == null && b.addedOn == null && b.fromNear == null) continue;
    if (!(b.addedBy in MANAGERS)) problems.push(`${b.id}: addedBy "${b.addedBy}" is not a manager`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.addedOn ?? "")) problems.push(`${b.id}: addedOn must be YYYY-MM-DD`);
    if (ruleOf.get(b.id)?.id !== b.fromNear) problems.push(`${b.id}: fromNear "${b.fromNear}" is not the general rule it sits under`);
  }
  return problems;
}

// ---- Alerts ---------------------------------------------------------------------

const REF_ID = ["conversation_id", "photo_verification_id", "scenario_id", "order_id"];

/** One alert per thing that went wrong, stable across sweeps: the same stuck
 * order seen every 30 minutes is still one alert. */
export function alertId(signal) {
  const ref = signal.ref ?? {};
  const id = REF_ID.map((k) => ref[k]).find((v) => v != null) ?? "none";
  return `${signal.source}:${id}:${signal.key}`;
}

const NEAR_TOOL = (rules) => ({
  type: "function",
  function: {
    name: "place_alert",
    description: "Name the general rule this alert is a case of, and how close it is.",
    parameters: {
      type: "object",
      properties: {
        rule: { type: "string", enum: rules.map((r) => r.id) },
        distance: { type: "string", enum: ["near", "far"], description: "near: clearly a case of that rule. far: no rule fits well." },
        why: { type: "string", description: "One short sentence." },
      },
      required: ["rule", "distance", "why"],
    },
  },
});

/** The request body for the near match (OpenRouter, OpenAI shape, one forced
 * tool). Ids are left out of the story: they say nothing about the rule. */
export function nearMatchRequest(alert, rules = RULES, model = NEAR_MATCH.model) {
  const { conversation_id, photo_verification_id, scenario_id, order_id, ...story } = alert.ref ?? {};
  const ruleList = rules.map((r) => `- ${r.id}: ${r.text} (situations: ${r.members.slice(0, 6).join(", ")}${r.members.length > 6 ? ", ..." : ""})`).join("\n");
  return {
    model,
    tools: [NEAR_TOOL(rules)],
    tool_choice: { type: "function", function: { name: "place_alert" } },
    messages: [
      { role: "system", content: "You sort alerts from the shop's flower-order loop under general rules. Answer near only when the alert is clearly a case of that rule; when in doubt answer far. Keeping two different problems apart is better than merging them." },
      { role: "user", content: `General rules:\n${ruleList}\n\nAlert (${alert.source}, key "${alert.key}"): ${alert.label}\nDetails: ${JSON.stringify(story)}` },
    ],
  };
}

/** The model's tool arguments -> a placement. A rule it made up counts as none. */
export function readNearAnswer(args, rules = RULES) {
  const known = rules.some((r) => r.id === args?.rule);
  if (!known) return { rule_id: null, match: "none", why: `model named no known rule (${args?.rule ?? "nothing"})` };
  if (args.distance !== "near") return { rule_id: null, match: "none", why: `far from ${args.rule}: ${args.why ?? ""}`.trim() };
  return { rule_id: args.rule, match: "near", why: String(args.why ?? "") };
}

/**
 * Places new alerts on general rules. Exact first (the key is a situation id,
 * free); else one near-match call per distinct story, `ask(request) ->
 * {args, costUsd}`. Two alerts with the same source, key and label send the
 * model the same story, so they share one answer within a sweep.
 * Past the daily cap, or when the call fails, the alert waits (not placed), so
 * the next sweep tries it again; nothing is dropped.
 * The cap holds: before each call the reserve kept free is the dearest call
 * seen so far (at least cap.reserveUsd), and a failed call counts what it cost
 * (`err.costUsd`, else the reserve). `calls` is every call made, answered or
 * failed, for the per-day ledger (factory_near_calls) the next sweep sums.
 * @returns {{placed: object[], waiting: {alert: object, why: string}[], spentUsd: number, calls: {alert_id: string, cost_usd: number, ok: boolean}[]}}
 */
export async function placeAlerts(alerts, { rules = RULES, ask = null, spentUsd = 0, cap = NEAR_MATCH } = {}) {
  const index = ruleIndex(rules);
  const placed = [];
  const waiting = [];
  const memo = new Map();
  const calls = [];
  let spent = spentUsd;
  let reserve = cap.reserveUsd;
  for (const alert of alerts) {
    const base = { ...alert, alert_id: alertId(alert) };
    const exact = index.get(alert.key);
    if (exact) { placed.push({ ...base, rule_id: exact.id, match: "exact", why: null, cost_usd: 0 }); continue; }
    const story = `${alert.source}
${alert.key}
${alert.label}`;
    if (memo.has(story)) { placed.push({ ...base, ...memo.get(story), cost_usd: 0 }); continue; }
    if (!ask) { waiting.push({ alert: base, why: "near match off (no OpenRouter key)" }); continue; }
    if (spent + reserve > cap.dailyCapUsd) { waiting.push({ alert: base, why: `daily near-match cap ($${cap.dailyCapUsd}) spent` }); continue; }
    let answer;
    try {
      answer = await ask(nearMatchRequest(alert, rules, cap.model));
    } catch (e) {
      const cost = Number(e.costUsd ?? reserve);
      spent += cost;
      reserve = Math.max(reserve, cost);
      calls.push({ alert_id: base.alert_id, cost_usd: cost, ok: false });
      waiting.push({ alert: base, why: `near match failed: ${e.message}` });
      continue;
    }
    const cost = Number(answer.costUsd ?? reserve);
    spent += cost;
    reserve = Math.max(reserve, cost);
    calls.push({ alert_id: base.alert_id, cost_usd: cost, ok: true });
    const placement = readNearAnswer(answer.args, rules);
    memo.set(story, placement);
    placed.push({ ...base, ...placement, cost_usd: cost });
  }
  return { placed, waiting, spentUsd: spent, calls };
}

// ---- A card's life ----------------------------------------------------------------

const LIVE = ["open", "in-progress"];
export const EXAMPLES_PER_RULE_CARD = 5;
export const ruleFingerprint = (ruleId) => `rule:${ruleId}`;

/** When the sweep last saw the alert: a problem still there (the same stuck
 * order every sweep) is one alert, first placed long ago and seen just now. */
export const seenAt = (a) => a.last_seen_at ?? a.placed_at;
const latestSeen = (list) => list.reduce((m, a) => (m == null || Date.parse(seenAt(a)) > Date.parse(m) ? seenAt(a) : m), null);

function ruleCard(rule, list, now, life) {
  const sorted = [...list].sort((a, b) => b.placed_at.localeCompare(a.placed_at));
  const recent = sorted.filter((a) => now - Date.parse(a.placed_at) <= life.openWindowDays * DAY_MS);
  const situations = {};
  for (const a of recent) situations[a.key] = (situations[a.key] ?? 0) + 1;
  const near = recent.filter((a) => a.match === "near").length;
  const manager = MANAGERS[rule.owner];
  return {
    fingerprint: ruleFingerprint(rule.id),
    agent: rule.agent ?? "factory",
    source: "rule",
    manager: rule.owner,
    general_rule: rule.id,
    title: `${manager.name}: ${rule.text}`,
    summary: `${recent.length} alert${recent.length === 1 ? "" : "s"} in the last ${life.openWindowDays} days broke this rule (${recent.length - near} exact, ${near} near match${near === 1 ? "" : "es"}).`,
    evidence: {
      problem: rule.id,
      count: recent.length,
      near,
      situations,
      life,
      examples: sorted.slice(0, EXAMPLES_PER_RULE_CARD).map((a) => ({ alert_id: a.alert_id, source: a.source, key: a.key, label: a.label, match: a.match, at: a.placed_at, ...(a.ref ?? {}) })),
    },
    latest_signal_at: latestSeen(list),
    // The rule's last sighting of any alert, not the sweep's clock and not the
    // alert's first placing: quietCards counts quiet days from it.
    last_seen_at: latestSeen(list),
  };
}

/**
 * What the sweep does with each general rule's card.
 * @param alerts factory_alerts rows placed on a rule (match exact or near),
 *   placed or seen in the window; `last_seen_at` is the alert's latest sighting.
 * @param cards  source 'rule' factory_tasks rows: {id, general_rule, status, closed_at}
 * @returns {{action: 'open'|'refresh'|'reopen', id?: string, card: object}[]}
 *   open: no card yet and the rule got CARD_LIFE.openAlerts alerts in the window.
 *   refresh: a live card, new evidence.
 *   reopen: a done card whose rule had an alert seen after it closed: the SAME card.
 *   A dropped or parked card was settled by a person and is left alone.
 */
export function ruleCardPlan({ alerts, cards, now = Date.now(), rules = RULES, life = CARD_LIFE }) {
  const plan = [];
  for (const rule of rules) {
    const list = alerts.filter((a) => a.rule_id === rule.id && (a.match === "exact" || a.match === "near"));
    const existing = cards.find((c) => c.general_rule === rule.id);
    if (!list.length && !existing) continue;
    const card = ruleCard(rule, list, now, life);
    if (!existing) {
      if (card.evidence.count >= life.openAlerts) plan.push({ action: "open", card });
    } else if (LIVE.includes(existing.status) || existing.status === WAITING) {
      // A card waiting for the owner's answer keeps its evidence fresh, but it
      // is not live for quietCards: it never closes while it waits.
      if (list.length) plan.push({ action: "refresh", id: existing.id, card });
    } else if (existing.status === "done") {
      const closed = existing.closed_at ? Date.parse(existing.closed_at) : 0;
      if (list.some((a) => Date.parse(seenAt(a)) > closed)) plan.push({ action: "reopen", id: existing.id, card, reopened_count: (existing.reopened_count ?? 0) + 1 });
    }
  }
  return plan;
}

/**
 * Live cards whose rule has stayed quiet CARD_LIFE.quietDays after the fix
 * merged: no alert (no refresh, for cards that are not rule cards) since the
 * later of merged_at and last_seen_at. A card with no merged fix never closes
 * by itself, nor one with a run still going (its publish would reopen it).
 * @param live factory_tasks rows with runs: [{finished_at}]
 * @returns the ids to close
 */
export function quietCards(live, now = Date.now(), life = CARD_LIFE) {
  return live
    .filter((t) => LIVE.includes(t.status) && t.merged_at)
    .filter((t) => !(t.runs ?? []).some((r) => !r.finished_at))
    .filter((t) => now - Math.max(Date.parse(t.merged_at), (t.last_seen_at ? Date.parse(t.last_seen_at) : 0)) >= life.quietDays * DAY_MS)
    .map((t) => t.id);
}

/** Whole quiet days left before a merged live card closes; null when no fix merged. */
export function quietDaysLeft(t, now = Date.now(), life = CARD_LIFE) {
  if (!t.merged_at) return null;
  const from = Math.max(Date.parse(t.merged_at), (t.last_seen_at ? Date.parse(t.last_seen_at) : 0));
  return Math.max(0, Math.ceil((from + life.quietDays * DAY_MS - now) / DAY_MS));
}
