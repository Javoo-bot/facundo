// Pure half of the factory sweep: garden rows in, task cards out. No I/O, so
// cards.test.mjs can drive it with plain objects.
//
// A signal is one row that says something went wrong: {source, agent, key,
// label, ref, at}. `agent` is the id of the file in agents/thinking/ whose job
// covers the problem, or null when no agent owns it (the order loop itself is
// code, not an agent). Each signal is an alert: general-rules.mjs places it on
// one of the 13 general rules, and cards open per general rule.

import {
  placementAttentionReason,
  LIVE_OFFER,
  IN_FULFILMENT,
  NEEDS_PLACING,
} from "../../dashboard/lib/cxAttentionRules.ts";
import { isInWorkingSet, extractDeliveryCountry } from "../../dashboard/lib/orderTags.ts";
import { ESCALATION_REASON_LABEL } from "../../dashboard/lib/conversationReasons.ts";
import { clusterCases, clusterKey, ruleGapCases } from "../../dashboard/lib/gardenPulse.ts";
import { madridDay, shiftDay } from "../monitoring/deep-analysis.mjs";
import { CLUSTER_RULE, judgeCluster } from "./cluster-rule.mjs";

export { LIVE_OFFER, IN_FULFILMENT, NEEDS_PLACING };

export const EXAMPLES_PER_CARD = 5;

const CONVERSATION_OWNER = { support: "concierge", recruiting: "cupid" };

const UNOWNED_ORDER_LOOP = "the order loop is code; no agent file owns it";

// Lifecycle branch or stage id (dashboard/lib/lifecycle.ts) -> agent whose job
// covers it. A garden scenario on any other branch tests the deterministic
// loop and has no agent owner.
export const LIFECYCLE_OWNER = {
  "deliver-bad-photo": "hawkeye",
  "deliver-reupload-fishing": "hawkeye",
  "deliver-partial": "hawkeye",
  "deliver-recycled-photo": "hawkeye",
  "pay-deliver-unchecked-photo": "hawkeye",
  "accept-has-questions": "concierge",
  "x-support-facts-stale": "concierge",
  "x-support-thread-unanswered": "concierge",
  "x-ai-reply-wrong": "cupid",
  "reachout-order-content-untranslated": "babel",
  "match-ingest-found-nothing": "scout",
  "match-ingest-noise": "bloom",
  "reachout-no-email-ever-extracted": "sherlock",
};

// Stuck-order problem key -> owner. Only "nobody left in range" has one: the
// fix is finding more florists there, which starts with Scout.
const STUCK_OWNER = { "escalated:pool_exhausted": "scout" };

const PHOTO_LABEL = {
  review: "The photo check could not decide, so a person has to look at the photo",
  fail: "The photo check said the photo does not show what was ordered",
  "provider-error": "One of the photo checkers failed with an error instead of voting",
};

export function conversationSignals(rows) {
  return rows.map((c) => {
    const key = c.escalation_reason ?? "unknown";
    return {
      source: "conversation_escalation",
      agent: CONVERSATION_OWNER[c.kind] ?? null,
      unownedWhy: `conversation kind ${c.kind}`,
      key,
      label: ESCALATION_REASON_LABEL[key] ?? `Handed to a person (${key})`,
      ref: { conversation_id: c.id, order_id: c.order_id ?? null },
      at: c.last_inbound_at ?? c.created_at ?? null,
    };
  });
}

// Mirrors gatherAttention's "place" and "delivery" rules (dashboard/lib/
// cxAttention.ts rules 1, 2, 2b and 3), then its working-set filter.
// `orders` holds every non-deleted order in NEEDS_PLACING, reaching_out or
// IN_FULFILMENT; `liveOffers` every assignment in LIVE_OFFER.
export function stuckOrderSignals({ orders, liveOffers, criteria, now = new Date() }) {
  const nowIso = now.toISOString();
  const withLiveOffer = new Set(liveOffers.map((a) => a.order_id));
  const stalled = new Map();
  for (const a of liveOffers) {
    if (a.sla_deadline_at && a.sla_deadline_at < nowIso) stalled.set(a.order_id, a.sla_deadline_at);
  }
  const out = [];
  for (const o of orders) {
    const inSet = isInWorkingSet({
      tags: o.tags ?? null,
      deliveryCountry: extractDeliveryCountry(o.delivery_address ?? null),
      deliveryAt: o.delivery_at ?? null,
      hasExplicitPick: o.worklist_at != null,
    }, criteria, now);
    if (!inSet) continue;
    const found = [];
    if (NEEDS_PLACING.includes(o.status)) {
      const key = o.status === "escalated" ? `escalated:${o.escalation_reason ?? "none"}` : "awaiting-reach-out";
      found.push([key, placementAttentionReason(o.status, o.delivery_at, o.escalation_reason).label]);
    }
    if (stalled.has(o.id)) found.push(["offer-stalling", "Offer stalling — SLA breached"]);
    if (o.status === "reaching_out" && !withLiveOffer.has(o.id)) found.push(["needs-next-florist", "Needs next florist — no live offer"]);
    if (IN_FULFILMENT.includes(o.status) && o.delivery_at && o.delivery_at < nowIso) found.push(["late-delivery", "Late — past the delivery window"]);
    for (const [key, label] of found) {
      out.push({
        source: "stuck_order",
        agent: STUCK_OWNER[key] ?? null,
        unownedWhy: UNOWNED_ORDER_LOOP,
        key,
        label,
        ref: { order_id: o.id, order_name: o.order_name ?? null },
        at: o.delivery_at ?? null,
      });
    }
  }
  return out;
}

export function photoSignals(rows) {
  return rows
    .filter((p) => p.verdict === "review" || p.verdict === "fail")
    .map((p) => {
      const errored = (p.providers ?? []).some((v) => v && v.error);
      const key = errored ? "provider-error" : p.verdict;
      return {
        source: "photo_review",
        agent: "hawkeye",
        key,
        label: PHOTO_LABEL[key],
        ref: { photo_verification_id: p.id, order_id: p.order_id, confidence: p.confidence ?? null },
        at: p.created_at ?? null,
      };
    });
}

// rows: garden_scores with passed = false, each carrying its scenario.
export function gardenScoreSignals(rows) {
  return rows.map((s) => {
    const key = s.scenario.branch_id ?? s.scenario.stage_id;
    return {
      source: "garden_score",
      agent: LIFECYCLE_OWNER[key] ?? null,
      unownedWhy: UNOWNED_ORDER_LOOP,
      key,
      label: `Garden test failed: ${s.scenario.title}`,
      ref: { scenario_id: s.scenario_id, shopify_order_id: s.scenario.shopify_order_id, actual: s.actual_outcome ?? null, expected: s.scenario.expected_outcome, notes: s.notes ?? null },
      at: s.scored_at ?? null,
    };
  });
}

// ---- the owner's ideas and big clusters ------------------------------------------
// He steers the agents from the Garden pulse page, never case by case: an idea
// he wrote (garden_ideas) or a cluster of rule gaps (Phase 4's agent_events)
// becomes one card against one agent's thinking file.

/** One card per open idea that names an agent. The idea id is in the
 * fingerprint, so a rerun refreshes the same card. */
export function ideaCards(ideas, nicks) {
  return ideas
    .filter((i) => i.status === "open" && i.agent && i.agent in nicks)
    .map((i) => ({
      fingerprint: `${i.agent}:human:idea-${i.id}`,
      agent: i.agent,
      source: "human",
      ideaId: i.id,
      title: `${nicks[i.agent]}: ${i.title}`,
      summary: i.body ? `the owner's idea: ${i.body}` : `the owner's idea: ${i.title}`,
      evidence: { count: 1, idea: { id: i.id, title: i.title, body: i.body, by: i.created_by ?? null } },
      latest_signal_at: i.updated_at ?? i.created_at ?? null,
    }));
}

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "none";

/** agent_events rows -> one card per (agent, reason) rule-gap cluster that an
 * agent owns and that passes the cluster rule (cluster-rule.mjs): it kept
 * coming back, on days when it was significantly above the noise floor.
 * `totals`: Madrid day -> every case the agents handled that day. */
export function clusterCards(events, nicks, totals, { today = madridDay(), rule = CLUSTER_RULE } = {}) {
  const days = Array.from({ length: rule.windowDays }, (_, i) => shiftDay(today, i - rule.windowDays + 1));
  const inWindow = new Set(days);
  const perCluster = new Map();
  const cases = ruleGapCases(events).filter((c) => c.at && inWindow.has(madridDay(new Date(c.at))));
  for (const c of cases) {
    const k = clusterKey(c);
    const perDay = perCluster.get(k) ?? new Map();
    const day = madridDay(new Date(c.at));
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    perCluster.set(k, perDay);
  }
  return clusterCases(cases, EXAMPLES_PER_CARD)
    .filter((c) => c.agent && c.agent in nicks)
    .map((c) => ({ c, verdict: judgeCluster(perCluster.get(c.key), totals, days, rule) }))
    .filter(({ verdict }) => verdict.card)
    .map(({ c, verdict }) => ({
      fingerprint: `${c.agent}:cluster:${slug(c.reason)}`,
      agent: c.agent,
      source: "cluster",
      title: `${nicks[c.agent]}: no rule for cases held at ${c.reason}`,
      summary: `${c.count} cases were held at ${c.reason} for want of a rule, on ${verdict.occasions.length} days well above the noise floor.${c.ruleGap ? ` The newest gap: ${c.ruleGap}` : ""}`,
      evidence: {
        problem: c.reason,
        count: c.count,
        occasions: verdict.occasions,
        rule,
        examples: c.examples.map((e) => ({ link: e.link, at: e.at, rule_gap: e.ruleGap })),
      },
      latest_signal_at: c.latestAt,
    }));
}

// ---- Doctor lane: the factory's own failed runs ---------------------------------
// Two failed runs (time cap included) with the same kind in 24 hours are one
// card for the doctor (factory-doctor.yml), source and agent 'factory'. An
// outage (Claude login, rate limit, Anthropic 5xx) is not a code bug: no card,
// the sweep prints it instead.

export const FACTORY_WINDOW_MS = 24 * 3600_000;
export const FACTORY_MIN_FAILURES = 2;

// First match wins; the "never finished" prefix is checked before what follows it.
const FAILURE_KINDS = [
  ["agent-step-crashed", /^The agent step never finished/, "the agent step never finished (cancelled or crashed)"],
  ["time-cap", /Stopped at the time cap/, "runs stop at the time cap before finishing"],
  ["no-report", /without a valid report\.md/, "the agent ends without a valid report"],
  ["box-exit", /The box exited with code/, "the agent's box exits with an error and no report"],
  ["video-committed", /Committed a video/, "the agent commits videos into git"],
  ["never-finished", /Never finished: the executor died/, "the executor dies before closing its run"],
  ["executor-error", /^Executor error:/, "the executor itself throws an error"],
];

const OUTAGES = [
  ["claude-login", /authentication_error|oauth token[^.\n]*(expired|invalid|revoked)|invalid api key|invalid bearer|\bAPI Error: 401\b/i],
  ["rate-limit", /rate[_ -]?limit|\bAPI Error: 429\b|usage limit/i],
  ["anthropic-5xx", /\bAPI Error: 5\d\d\b|overloaded_error|internal server error|"type":"api_error"/i],
];

export function runFailureKind(notes) {
  const text = String(notes ?? "");
  const kind = FAILURE_KINDS.find(([, re]) => re.test(text))?.[0] ?? "other";
  const outage = OUTAGES.find(([, re]) => re.test(text))?.[0] ?? null;
  return { kind, outage };
}

const KIND_LABEL = Object.fromEntries(FAILURE_KINDS.map(([k, , label]) => [k, label]));

/** runs: factory_runs rows with task: {source}. `parked`: fingerprints of
 * parked factory cards, which a person settles before a new card appears. */
export function factoryCards(runs, { now = Date.now(), parked = [] } = {}) {
  const groups = new Map();
  const outages = [];
  for (const r of runs) {
    if (r.outcome !== "failed" || r.task?.source === "factory") continue;
    if (!r.finished_at || now - Date.parse(r.finished_at) > FACTORY_WINDOW_MS) continue;
    const { kind, outage } = runFailureKind(r.notes);
    if (outage) { outages.push({ run_id: r.id, task_id: r.task_id, at: r.finished_at, outage }); continue; }
    groups.set(kind, [...(groups.get(kind) ?? []), r]);
  }
  const cards = [...groups.entries()]
    .filter(([kind, list]) => list.length >= FACTORY_MIN_FAILURES && !parked.includes(`factory:factory:${kind}`))
    .map(([kind, list]) => {
      const sorted = [...list].sort((a, b) => b.finished_at.localeCompare(a.finished_at));
      const label = KIND_LABEL[kind] ?? "runs fail in a way the sweep does not name yet";
      return {
        fingerprint: `factory:factory:${kind}`,
        agent: "factory",
        source: "factory",
        title: `Factory: ${label}`,
        summary: `${list.length} factory runs failed this way in the last 24 hours: ${label}.`,
        evidence: { problem: kind, count: list.length, examples: sorted.slice(0, EXAMPLES_PER_CARD).map((r) => ({ run_id: r.id, task_id: r.task_id, at: r.finished_at, notes: String(r.notes ?? "").slice(0, 600) })) },
        latest_signal_at: sorted[0].finished_at,
      };
    });
  return { cards, outages: outages.sort((a, b) => b.at.localeCompare(a.at)) };
}

// ---- Errors from the order loop (PostHog) ------------------------------------------
// The worker sends three failure events to the garden's PostHog. Events with the
// same context and the same first line of error are one problem. cluster-rule.mjs
// does not fit: it needs every case of the day as a denominator, and PostHog only
// holds the failures. So the rule is plain: ERROR_MIN_EVENTS in 24 hours make a
// card (source 'error', agent 'factory', brief agents/factory/errors.md), and at
// most ERROR_CARDS_PER_DAY new ones a Madrid day; a live card is only refreshed.

export const ERROR_EVENTS = ["order_automation_failed", "order_match_failed", "order_workflow_step_failed"];
export const ERROR_MIN_EVENTS = 2;
export const ERROR_CARDS_PER_DAY = 3;

/** One PostHog event -> {context, line}. Ids and numbers become # so the same
 * error on two orders is one problem. */
export function errorKey(e) {
  const p = e.properties ?? {};
  const context = e.event === "order_workflow_step_failed" ? `workflow.${p.step ?? "unknown"}`
    : e.event === "order_match_failed" ? `match.${p.mode ?? "unknown"}`
    : String(p.context ?? "unknown");
  const raw = e.event === "order_match_failed" ? `nobody in range (ingest: ${p.ingest_outcome ?? "unknown"})` : p.message ?? "no message";
  const line = String(raw).split("\n")[0].trim()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/\d+/g, "#")
    .slice(0, 200);
  return { context, line };
}

// Short stable hash, so two long messages with the same start stay two cards.
const hash = (s) => { let h = 5381; for (const ch of s) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return h.toString(36); };

/** events: PostHog rows {event, timestamp, properties}. `live`: fingerprints of
 * open/in-progress cards. `openedToday`: error cards created in the last 24 hours. */
export function errorCards(events, { now = Date.now(), live = [], openedToday = 0, min = ERROR_MIN_EVENTS, perDay = ERROR_CARDS_PER_DAY } = {}) {
  const groups = new Map();
  for (const e of events) {
    if (!ERROR_EVENTS.includes(e.event)) continue;
    if (!e.timestamp || now - Date.parse(e.timestamp) > FACTORY_WINDOW_MS) continue;
    const { context, line } = errorKey(e);
    const fp = `factory:error:${slug(context)}-${hash(`${context}\n${line}`)}`;
    const g = groups.get(fp) ?? { fp, context, line, list: [] };
    g.list.push(e);
    groups.set(fp, g);
  }
  const ranked = [...groups.values()].filter((g) => g.list.length >= min)
    .sort((a, b) => b.list.length - a.list.length || a.fp.localeCompare(b.fp));
  let room = Math.max(0, perDay - openedToday);
  const cards = [];
  const held = [];
  for (const g of ranked) {
    if (!live.includes(g.fp)) {
      if (!room) { held.push({ context: g.context, line: g.line, count: g.list.length }); continue; }
      room--;
    }
    const sorted = [...g.list].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    cards.push({
      fingerprint: g.fp,
      agent: "factory",
      source: "error",
      title: `Order loop error: ${g.context}: ${g.line}`.slice(0, 200),
      summary: `${g.list.length} "${g.context}" failures in the last 24 hours, all starting "${g.line}".`,
      evidence: { problem: g.context, line: g.line, count: g.list.length, examples: sorted.slice(0, EXAMPLES_PER_CARD).map((e) => ({ event: e.event, at: e.timestamp, ...e.properties })) },
      latest_signal_at: sorted[0].timestamp,
    });
  }
  return { cards, held };
}

// Closing cards: quietCards() in general-rules.mjs (7 quiet days after the merge).

// Which Supabase is the garden: garden-url.mjs (GARDEN_SUPABASE_URL), re-exported
// here so the sweep and the monitoring scripts keep one import.
export { gardenRef, assertGardenUrl } from "./garden-url.mjs";
