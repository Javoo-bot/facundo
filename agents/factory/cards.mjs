// Pure half of the factory sweep: garden rows in, task cards out. No I/O, so
// cards.test.mjs can drive it with plain objects.
//
// A signal is one row that says something went wrong: {source, agent, key,
// label, ref, at}. `agent` is the id of the file in agents/thinking/ whose job
// covers the problem, or null when no agent owns it (the order loop itself is
// code, not an agent). Signals with the same agent, source and key are one
// problem and become one card.

import {
  placementAttentionReason,
  LIVE_OFFER,
  IN_FULFILMENT,
  NEEDS_PLACING,
} from "../../dashboard/lib/cxAttentionRules.ts";
import { isInWorkingSet, extractDeliveryCountry } from "../../dashboard/lib/orderTags.ts";
import { ESCALATION_REASON_LABEL } from "../../dashboard/lib/conversationReasons.ts";

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

export const fingerprint = (s) => `${s.agent}:${s.source}:${s.key}`;

const SUMMARY = {
  conversation_escalation: (n, label) => `${n} conversation${n === 1 ? " is" : "s are"} waiting on a person. Reason: ${label}.`,
  stuck_order: (n, label) => `${n} order${n === 1 ? " is" : "s are"} stuck in the working set. ${label}.`,
  photo_review: (n, label) => `${n} delivery photo check${n === 1 ? "" : "s"} ended this way. ${label}.`,
  garden_score: (n, label) => `${n} garden scoring${n === 1 ? "" : "s"} did not end as expected. ${label}.`,
};

// nicks: agent id -> display name. Returns one card per owned problem, plus a
// tally of signals no agent owns, so the sweep can say what it skipped.
export function buildCards(signals, nicks) {
  const groups = new Map();
  const unowned = new Map();
  for (const s of signals) {
    if (!s.agent) {
      const k = `${s.source}:${s.key}`;
      const u = unowned.get(k) ?? { source: s.source, key: s.key, label: s.label, why: s.unownedWhy, count: 0 };
      u.count++;
      unowned.set(k, u);
      continue;
    }
    if (!(s.agent in nicks)) throw new Error(`signal mapped to unknown agent "${s.agent}"`);
    const fp = fingerprint(s);
    const g = groups.get(fp) ?? [];
    g.push(s);
    groups.set(fp, g);
  }
  const cards = [...groups.entries()].map(([fp, list]) => {
    const { agent, source, key, label } = list[0];
    const sorted = [...list].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
    return {
      fingerprint: fp,
      agent,
      source,
      title: `${nicks[agent]}: ${label}`,
      summary: SUMMARY[source](list.length, label),
      evidence: { problem: key, count: list.length, examples: sorted.slice(0, EXAMPLES_PER_CARD).map((s) => ({ ...s.ref, at: s.at })) },
      latest_signal_at: sorted.find((s) => s.at)?.at ?? null,
    };
  });
  cards.sort((a, b) => b.evidence.count - a.evidence.count || a.fingerprint.localeCompare(b.fingerprint));
  return { cards, unowned: [...unowned.values()].sort((a, b) => b.count - a.count) };
}

export const GARDEN_REF = "your-project-ref";

// Throws unless the URL is the side-project Supabase. Production must never
// receive factory cards or be read by the sweep.
export function assertGardenUrl(url) {
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error(`refusing to run: "${url}" is not a URL`); }
  if (host !== `${GARDEN_REF}.supabase.co`) throw new Error(`refusing to run: ${host} is not the garden (${GARDEN_REF})`);
}
