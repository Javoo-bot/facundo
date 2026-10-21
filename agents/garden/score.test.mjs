import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, OUTCOMES } from './score.mjs';

const NOW = new Date('2026-10-14T05:00:00Z');
const scenario = (expected_outcome, hoursAgo, expected = {}) => ({
  expected_outcome, expected, created_at: new Date(NOW - hoursAgo * 3600000).toISOString(),
});
const bundle = (over = {}) => ({
  order: { id: 'o1', status: 'received', escalation_reason: null },
  assignments: [], payouts: [], approvals: [], conversations: [], events: [], ...over,
});
const paidBundle = bundle({
  order: { id: 'o1', status: 'paid', escalation_reason: null },
  assignments: [{ sent_at: 't', accepted_at: 't', delivered_at: 't' }],
  payouts: [{ leg: 'accept', status: 'issued' }, { leg: 'delivery', status: 'issued' }],
});

test('a paid order passes "paid" as soon as it is true, without waiting for max_minutes', () => {
  const v = judge(scenario('paid', 1), paidBundle, NOW);
  assert.equal(v.passed, true);
  assert.equal(v.actual_outcome, 'paid');
  assert.match(v.notes, /As expected, it ended with the florist paid in full/);
});

test('earlier steps count: a paid order also passes "accepted" and "offered"', () => {
  assert.equal(judge(scenario('accepted', 1), paidBundle, NOW).passed, true);
  assert.equal(judge(scenario('offered', 1), paidBundle, NOW).passed, true);
});

test('an order expected to escalate that got paid instead fails once settled, in plain words', () => {
  const v = judge(scenario('escalated', 7), paidBundle, NOW);
  assert.equal(v.passed, false);
  assert.equal(v.actual_outcome, 'paid');
  assert.match(v.notes, /Expected: it was handed to a person\. Instead, after 7 hours, it ended with the florist paid in full\./);
});

test('not settled yet: expected word not true and younger than max_minutes gives no row', () => {
  assert.equal(judge(scenario('paid', 1), bundle(), NOW), null);
  assert.equal(judge(scenario('paid', 3, { max_minutes: 120 }), bundle(), NOW).passed, false);
});

test('an order that never arrived reads as missing', () => {
  const v = judge(scenario('escalated', 9), { order: null, assignments: [], payouts: [], approvals: [], conversations: [], events: [] }, NOW);
  assert.equal(v.actual_outcome, 'missing');
  assert.equal(v.passed, false);
});

test('an unknown expected word fails at once and says so', () => {
  const v = judge(scenario('teleported', 0), bundle(), NOW);
  assert.equal(v.passed, false);
  assert.match(v.notes, /not a word the score knows/);
});

test('untouched holds only while nothing touched the order', () => {
  assert.equal(judge(scenario('untouched', 1), bundle(), NOW).passed, true);
  const v = judge(scenario('untouched', 9), bundle({ assignments: [{ sent_at: null }] }), NOW);
  assert.equal(v.passed, false);
  assert.equal(v.actual_outcome, 'matched');
});

test('a pending approval and a held payout are reported, held wins the headline over escalated', () => {
  const v = judge(scenario('held', 1), bundle({
    order: { id: 'o1', status: 'escalated', escalation_reason: 'x' },
    payouts: [{ leg: 'delivery', status: 'held' }],
    approvals: [{ kind: 'chase_photo', status: 'pending' }],
  }), NOW);
  assert.equal(v.passed, true);
  assert.equal(v.actual_outcome, 'held');
  assert.deepEqual(v.detail.waiting_on, ['approve the chase photo step']);
});

test('every outcome word is unique', () => {
  assert.equal(new Set(OUTCOMES.map((o) => o.word)).size, OUTCOMES.length);
});
