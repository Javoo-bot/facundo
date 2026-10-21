import crypto from 'node:crypto';

export const EVENT_PREFIX = 'garden-actor';
export const MAX_OUTBOUND_AGE_MS = 36 * 3600 * 1000;

export function parsePersonas(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [id, role, lang, max, brief] = l.split('|').map((s) => s.trim());
      if (!['florist', 'client'].includes(role) || !brief) throw new Error(`bad persona line: ${l}`);
      return { id, role, lang, maxReplies: Number(max), brief };
    });
}

export function isGardenOrder(order) {
  return /^#?GARDEN-/.test(order.order_name ?? '') || /\bGARDEN\b/.test(order.tags ?? '');
}

export function isPlusAddressOf(address, base) {
  if (!address || !base) return false;
  const [local, domain] = base.toLowerCase().split('@');
  const a = address.toLowerCase().trim();
  return a.startsWith(`${local}+`) && a.endsWith(`@${domain}`) && a.length > local.length + domain.length + 2;
}

/** An invented client: a plus-address of the test inbox, or an unroutable .example address. */
export function isGardenClient(email, testEmail) {
  return isPlusAddressOf(email, testEmail) || /@[^@\s]+\.example$/i.test(email ?? '');
}

/** A florist the weather invented: place_id GARDEN_… or a "[GARDEN]" name, with an email to reply from.
 * Not tied to test_email: that inbox changed on 2026-10-13 and the florists kept their old plus-addresses. */
export function isGardenFlorist(florist) {
  const marked = (florist.place_id ?? '').startsWith('GARDEN_') || (florist.name ?? '').includes('[GARDEN]');
  return marked && /^[^@\s]+@[^@\s]+$/.test(florist.email ?? '');
}

export function personKey(comm) {
  return comm.audience === 'client' ? 'client' : `f-${comm.florist_id}`;
}

export function eventId(comm) {
  return `${EVENT_PREFIX}:${comm.order_id}:${personKey(comm)}:${comm.id}`;
}

export function parseEventId(id) {
  const [prefix, orderId, person, sourceId] = (id ?? '').split(':');
  return prefix === EVENT_PREFIX && sourceId ? { orderId, person, sourceId } : null;
}

function hash(s) {
  return crypto.createHash('sha256').update(s).digest().readUInt32BE(0);
}

export function personaFor(personas, role, orderId, person) {
  const pool = personas.filter((p) => p.role === role);
  return pool[hash(`${orderId}:${person}`) % pool.length];
}

/**
 * Which outbound emails get a pretend reply this run.
 * comms: outbound email rows already filtered to GARDEN orders and GARDEN people.
 * priorEventIds: provider_event_id of every inbound message this runner injected before.
 * One reply per person per order per run, only to that person's latest email, never to
 * the same email twice, and never more than the persona's limit in a conversation.
 */
export function planReplies(comms, priorEventIds, personas, nowMs) {
  const prior = priorEventIds.map(parseEventId).filter(Boolean);
  const latest = new Map();
  for (const c of comms) {
    const key = `${c.order_id}:${personKey(c)}`;
    const cur = latest.get(key);
    if (!cur || c.created_at > cur.created_at) latest.set(key, c);
  }
  const plan = [];
  for (const c of latest.values()) {
    if (nowMs - Date.parse(c.created_at) > MAX_OUTBOUND_AGE_MS) continue;
    const person = personKey(c);
    const mine = prior.filter((p) => p.orderId === c.order_id && p.person === person);
    if (mine.some((p) => p.sourceId === c.id)) continue;
    const persona = personaFor(personas, c.audience === 'client' ? 'client' : 'florist', c.order_id, person);
    if (mine.length >= persona.maxReplies) continue;
    plan.push({ comm: c, persona, eventId: eventId(c) });
  }
  return plan;
}

/** orders.delivery_address is a string on old rows and {line1, line2, postal, city, ...} on new ones. */
export function formatAddress(a) {
  if (!a || typeof a === 'string') return a ?? '';
  return [a.line1, a.line2, [a.postal, a.city].filter(Boolean).join(' '), a.region, a.country].filter(Boolean).join(', ');
}

export function stripThinking(text) {
  const end = text.lastIndexOf('</think>');
  return (end >= 0 ? text.slice(end + '</think>'.length) : text).trim();
}

/** Svix v1 signature, the scheme dashboard/lib/resendWebhookGuard.ts verifies. */
export function svixHeaders(id, payload, secret, nowMs = Date.now()) {
  const ts = String(Math.floor(nowMs / 1000));
  const key = Buffer.from(secret.split('_')[1] ?? '', 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}
