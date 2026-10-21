// Daily garden score: for each invented order (garden_scenarios row) that has settled, read what
// the loop actually did to it and upsert one garden_scores row for today (Madrid date).
//
//   node --env-file=dashboard/.env.local agents/garden/score.mjs
//
// Idempotent: re-running on the same day overwrites today's rows (unique scenario_id + scored_on).
// A scenario already scored on an earlier day is final and is not scored again.
//
// OUTCOME WORDS. garden_scenarios.expected_outcome must be one of the words below; the weather
// writes them, this file is the only place that defines them. Each word is a fact about the
// order that is either true or not, so several can be true at once (an order that was paid was
// also offered and accepted). A scenario passes when its expected word is true. actual_outcome
// is the first true word, top to bottom.
//
//   word               true when
//   missing            no order was found for the scenario (by order_id, shopify_order_id or order_name)
//   cancelled          orders.status = cancelled
//   paid               a delivery-leg payout is issued or paid, or orders.status = paid
//   held               any payout is held for review (status held, or a payout_held event)
//   escalated          orders.status = escalated, escalation_reason set, an escalated event,
//                      or a support conversation on the order was escalated
//   awaiting_approval  an order_approvals row is still pending (the loop stopped for a person's OK)
//   delivered          an assignment has delivered_at, a delivered_photo event, or status delivered/paid
//   accepted           an assignment has accepted_at
//   reoffered          offers went to two or more florists, or an offer_resent / rematched event
//   offered            an assignment has sent_at, or an outreach_sent event
//   matched            the order has at least one assignment (candidate florists found)
//   untouched          the order exists, has no assignments, is still received and was never escalated
//                      (what an order outside the working set should look like)
//   received           the order exists
//
// SETTLING. A scenario is judged once its expected word is true, or once it is older than
// expected.max_minutes (default 360) after garden_scenarios.created_at. Before that it is left
// alone and the report lists it as still running. expected.attention_label is recorded but not
// checked: this score sees approvals, payouts and conversations, not the whole CX desk list.

import { pathToFileURL } from 'node:url';
import { gardenDb, madridDate } from './watch-db.mjs';

export const DEFAULT_MAX_MINUTES = 360;
const LOOKBACK_DAYS = 14;

const has = (b, type) => b.events.some((e) => e.type === type);
const sentCount = (b) => b.assignments.filter((a) => a.sent_at).length;

export const OUTCOMES = [
  { word: 'missing', plain: 'never arrived as an order', test: (b) => !b.order },
  { word: 'cancelled', plain: 'was cancelled', test: (b) => b.order.status === 'cancelled' },
  {
    word: 'paid', plain: 'ended with the florist paid in full',
    test: (b) => b.order.status === 'paid' || b.payouts.some((p) => p.leg === 'delivery' && (p.status === 'issued' || p.status === 'paid')),
  },
  { word: 'held', plain: 'ended with the payment held for a person to check', test: (b) => b.payouts.some((p) => p.status === 'held') || has(b, 'payout_held') },
  {
    word: 'escalated', plain: 'was handed to a person',
    test: (b) => b.order.status === 'escalated' || !!b.order.escalation_reason || has(b, 'escalated') || b.conversations.some((c) => c.escalated_at),
  },
  { word: 'awaiting_approval', plain: 'stopped, waiting for a person to approve a step', test: (b) => b.approvals.some((a) => a.status === 'pending') },
  {
    word: 'delivered', plain: 'was delivered with a photo',
    test: (b) => b.assignments.some((a) => a.delivered_at) || has(b, 'delivered_photo') || b.order.status === 'delivered' || b.order.status === 'paid',
  },
  { word: 'accepted', plain: 'was accepted by a florist', test: (b) => b.assignments.some((a) => a.accepted_at) },
  { word: 'reoffered', plain: 'was offered to a second florist', test: (b) => sentCount(b) >= 2 || has(b, 'offer_resent') || has(b, 'rematched') },
  { word: 'offered', plain: 'was offered to a florist', test: (b) => sentCount(b) >= 1 || has(b, 'outreach_sent') },
  { word: 'matched', plain: 'got a list of nearby florists', test: (b) => b.assignments.length > 0 },
  {
    word: 'untouched', plain: 'was left alone',
    test: (b) => b.assignments.length === 0 && b.order.status === 'received' && !OUTCOMES.find((o) => o.word === 'escalated').test(b),
  },
  { word: 'received', plain: 'arrived and nothing else happened', test: () => true },
];
const BY_WORD = new Map(OUTCOMES.map((o) => [o.word, o]));

export function plain(word) {
  return BY_WORD.get(word)?.plain ?? `"${word}"`;
}

function waitingOn(b) {
  if (!b.order) return [];
  const out = b.approvals.filter((a) => a.status === 'pending').map((a) => `approve the ${a.kind.replace(/_/g, ' ')} step`);
  if (b.payouts.some((p) => p.status === 'failed')) out.push('a failed payout');
  if (b.conversations.some((c) => c.cx_unread)) out.push('an unread florist message');
  return out;
}

// Pure: scenario + what happened -> score row fields, or null when it has not settled yet.
export function judge(scenario, bundle, now = new Date()) {
  const reached = bundle.order ? OUTCOMES.filter((o) => o.word !== 'missing' && o.test(bundle)).map((o) => o.word) : ['missing'];
  const expected = scenario.expected_outcome;
  const known = BY_WORD.has(expected);
  const maxMinutes = Number(scenario.expected?.max_minutes) || DEFAULT_MAX_MINUTES;
  const ageMinutes = (now - new Date(scenario.created_at)) / 60000;
  const passed = known && reached.includes(expected);
  if (!passed && known && ageMinutes < maxMinutes) return null;

  const headline = reached[0];
  const waiting = waitingOn(bundle);
  const notes = [];
  if (!known) notes.push(`The expected outcome "${expected}" is not a word the score knows (see the table at the top of agents/garden/score.mjs).`);
  else if (passed) notes.push(`As expected, it ${plain(expected)}.`);
  else notes.push(`Expected: it ${plain(expected)}. Instead, after ${Math.round(ageMinutes / 60)} hours, it ${plain(headline)}.`);
  const alongTheWay = reached.filter((w) => w !== headline && w !== expected && w !== 'received' && w !== 'matched');
  if (alongTheWay.length) notes.push(`Along the way it also ${alongTheWay.map(plain).join('; ')}.`);
  if (waiting.length) notes.push(`Waiting on a person: ${waiting.join(', ')}.`);

  return {
    actual_outcome: headline,
    passed,
    notes: notes.join(' '),
    detail: {
      reached,
      order_id: bundle.order?.id ?? null,
      order_status: bundle.order?.status ?? null,
      age_minutes: Math.round(ageMinutes),
      max_minutes: maxMinutes,
      waiting_on: waiting,
      ...(scenario.expected?.attention_label ? { attention_label_unchecked: scenario.expected.attention_label } : {}),
    },
  };
}

const ORDER_SELECT = [
  'id,status,escalation_reason,order_name,shopify_order_id',
  'order_assignments(id,status,sent_at,accepted_at,delivered_at,declined_at,payouts(leg,status))',
  'order_approvals(kind,status)',
  'conversations(kind,status,escalated_at,cx_unread)',
  'order_events(type,created_at)',
].join(',');

async function loadBundle(rest, s) {
  const q = (v) => `"${String(v).replace(/"/g, '')}"`;
  const ors = [s.order_id && `id.eq.${s.order_id}`, `shopify_order_id.eq.${q(s.shopify_order_id)}`, `order_name.eq.${q(s.shopify_order_id)}`].filter(Boolean);
  const [order] = await rest(`orders?select=${ORDER_SELECT}&or=${encodeURIComponent(`(${ors.join(',')})`)}&limit=1`);
  if (!order) return { order: null, assignments: [], payouts: [], approvals: [], conversations: [], events: [] };
  return {
    order,
    assignments: order.order_assignments,
    payouts: order.order_assignments.flatMap((a) => a.payouts),
    approvals: order.order_approvals,
    conversations: order.conversations.filter((c) => c.kind === 'support'),
    events: order.order_events,
  };
}

export async function score({ rest = gardenDb(), now = new Date() } = {}) {
  const today = madridDate(now);
  const since = new Date(now - LOOKBACK_DAYS * 86400000).toISOString();
  const scenarios = await rest(`garden_scenarios?select=*,garden_scores(scored_on)&created_at=gte.${since}&order=created_at`);
  const open = scenarios.filter((s) => !s.garden_scores.some((g) => g.scored_on !== today));
  const rows = [];
  let running = 0;
  for (const s of open) {
    const verdict = judge(s, await loadBundle(rest, s), now);
    if (!verdict) { running += 1; continue; }
    rows.push({ scenario_id: s.id, scored_on: today, scored_at: now.toISOString(), ...verdict });
  }
  if (rows.length) {
    await rest('garden_scores?on_conflict=scenario_id,scored_on', { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  return { today, considered: open.length, scored: rows.length, passed: rows.filter((r) => r.passed).length, running };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await score();
  console.log(`garden score ${r.today}: ${r.considered} open scenarios, ${r.scored} scored (${r.passed} passed, ${r.scored - r.passed} failed), ${r.running} still running`);
}
