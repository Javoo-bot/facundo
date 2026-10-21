// Picks the garden agents' outbound messages from the last day for the tone check (geval.py).
// At most MAX messages, newest first, to keep the check to a handful of model calls.
//
//   node --env-file=dashboard/.env.local agents/garden/tone/pick.mjs <out.json> [--hours 24]

import { writeFileSync } from 'node:fs';
import { gardenDb, argValue } from '../watch-db.mjs';

const MAX = 5;
const out = process.argv[2];
if (!out || out.startsWith('--')) throw new Error('usage: pick.mjs <out.json> [--hours 24]');
const hours = Number(argValue('hours') ?? 24);
const since = new Date(Date.now() - hours * 3600000).toISOString();

const rest = gardenDb();
const rows = await rest(
  `conversation_messages?select=id,status,created_at,body_text,conversations(kind)` +
  `&direction=eq.out&ai_generated=is.true&body_text=not.is.null&created_at=gte.${since}&order=created_at.desc&limit=${MAX}`,
);
const messages = rows.map((m) => ({
  id: m.id,
  to: m.conversations?.kind === 'recruiting' ? 'a florist we are recruiting' : 'a florist on an order',
  status: m.status,
  created_at: m.created_at,
  text: m.body_text.slice(0, 2000),
}));
writeFileSync(out, JSON.stringify(messages, null, 2));
console.log(`picked ${messages.length} agent messages from the last ${hours}h`);
