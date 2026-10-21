import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { eventId, isGardenClient, isGardenFlorist, isGardenOrder, parsePersonas, planReplies, stripThinking, svixHeaders } from './actors.mjs';

const personas = parsePersonas(fs.readFileSync(new URL('./personas.txt', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-13T12:00:00Z');
const comm = (id, minutesAgo, extra = {}) => ({
  id, order_id: 'o1', audience: 'florist', florist_id: 'f1', kind: 'offer',
  created_at: new Date(NOW - minutesAgo * 60e3).toISOString(), ...extra,
});

test('the persona file parses, with both roles present', () => {
  assert.ok(personas.length >= 8);
  assert.ok(personas.some((p) => p.role === 'florist') && personas.some((p) => p.role === 'client'));
});

test('only GARDEN orders and marked plus-address florists count', () => {
  assert.equal(isGardenOrder({ order_name: '#GARDEN-2026-10-13-07' }), true);
  assert.equal(isGardenOrder({ order_name: '#FC11-003', tags: 'fc11' }), false);
  assert.equal(isGardenOrder({ order_name: '#2000034', tags: 'Local-florist, GARDEN' }), true);
  const base = 'owner@fc.example.com';
  assert.equal(isGardenFlorist({ name: 'Floristería La Rosa [GARDEN]', place_id: 'GARDEN_A1', email: 'owner+garden-a1@fc.example.com' }), true);
  assert.equal(isGardenFlorist({ name: 'Rosa', place_id: 'GARDEN_A2', email: 'owner+garden-a2@fc.example.com' }), true);
  assert.equal(isGardenFlorist({ name: 'Example Garden Flowers', place_id: 'ChIJexampleExamplePlaceId00', email: 'owner+handsown@fc.example.com' }), false);
  assert.equal(isGardenFlorist({ name: 'GARDEN FLOWERS LTD', place_id: 'ChIJxyz', email: 'shop@example.com' }), false);
  assert.equal(isGardenFlorist({ name: '[FC11] Test shop', place_id: 'FC11_A', email: 'owner+fc11@fc.example.com' }), false);
  assert.equal(isGardenFlorist({ name: 'Floristería La Rosa [GARDEN]', place_id: 'GARDEN_A1', email: null }), false);
  assert.equal(isGardenClient('garden-buyer@facundo.example', base), true);
  assert.equal(isGardenClient('owner+buyer7@fc.example.com', base), true);
  assert.equal(isGardenClient('maria@gmail.com', base), false);
});

test('replies once to the latest email only', () => {
  const plan = planReplies([comm('a', 30), comm('b', 10)], [], personas, NOW);
  assert.deepEqual(plan.map((p) => p.comm.id), ['b']);
});

test('never replies to the same email twice', () => {
  const c = comm('b', 10);
  assert.equal(planReplies([c], [eventId(c)], personas, NOW).length, 0);
});

test('stops at the persona limit even when the agent writes again', () => {
  const sent = [comm('a', 60), comm('b', 30), comm('c', 5)];
  const persona = planReplies([sent[2]], [], personas, NOW)[0].persona;
  const prior = sent.slice(0, persona.maxReplies).map(eventId);
  assert.equal(planReplies(sent, prior, personas, NOW).length, 0);
});

test('ignores emails older than a day and a half', () => {
  assert.equal(planReplies([comm('old', 37 * 60)], [], personas, NOW).length, 0);
});

test('client and florist on one order are separate people', () => {
  const plan = planReplies([comm('f', 5), comm('c', 5, { audience: 'client', florist_id: null })], [], personas, NOW);
  assert.deepEqual(plan.map((p) => p.persona.role).sort(), ['client', 'florist']);
});

test('drops qwen3 reasoning, with or without the opening tag', () => {
  assert.equal(stripThinking('Okay, the user asks...\n</think>\n\nYes, we can do it.'), 'Yes, we can do it.');
  assert.equal(stripThinking('<think>hmm</think>Sí, sin problema.'), 'Sí, sin problema.');
  assert.equal(stripThinking('Plain reply.'), 'Plain reply.');
});

test('the dashboard webhook guard accepts the signature, and rejects a tampered body', async () => {
  const { verifyResendSignature } = await import('../../../dashboard/lib/resendWebhookGuard.ts');
  const secret = 'whsec_' + crypto.randomBytes(24).toString('base64');
  const h = svixHeaders('garden-actor:o1:f-f1:b', '{"x":1}', secret, NOW);
  assert.equal(verifyResendSignature('{"x":1}', h, secret, NOW), true);
  assert.equal(verifyResendSignature('{"x":2}', h, secret, NOW), false);
});
