// Pretend florists and clients answer the garden's emails. A local Ollama model writes
// each reply in persona; the reply goes in through the garden dashboard's real inbound
// email webhook, so the real support agent handles it.
//
//   node agents/garden/actors/run.mjs            reply to whatever is waiting
//   node agents/garden/actors/run.mjs --dry-run  print the replies, inject nothing
//   node agents/garden/actors/run.mjs --say "…"  inject one reply with this text, no model (tests the inbound path)
//   node agents/garden/actors/run.mjs --max 1    at most this many replies (default 2)
//
// Reads Supabase from dashboard/.env.local and GARDEN_INBOUND_WEBHOOK_SECRET from .env,
// both in the main checkout. Refuses any database but the side project.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatAddress, isGardenClient, isGardenFlorist, isGardenOrder, parsePersonas, planReplies, stripThinking, svixHeaders, EVENT_PREFIX } from './actors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = '/path/to/facundo';
const GARDEN_DB = 'your-project-ref';
const GARDEN_DASHBOARD = 'https://facundo-dashboard-garden.your-subdomain.workers.dev';
const OLLAMA = 'http://127.0.0.1:11434';
// qwen3:4b is Qwen3-4B-Thinking-2507: it always reasons first, which on this laptop's CPU
// (about 8 tokens a second) means 10 to 20 minutes a reply. The instruct build of the same
// model skips the reasoning (not yet measured here), so it is preferred once it is on disk.
const MODELS = ['qwen3:4b-instruct', 'qwen3:4b'];
const THINKS = new Set(['qwen3:4b']);
const DRY = process.argv.includes('--dry-run');
const SAY = process.argv.includes('--say') ? process.argv[process.argv.indexOf('--say') + 1] : null;
// Each reply takes minutes of laptop CPU and one real agent turn on the garden's $1/day
// OpenRouter key; spread them out.
const MAX_PER_RUN = process.argv.includes('--max') ? Number(process.argv[process.argv.indexOf('--max') + 1]) : 2;

function readEnv(file) {
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
  );
}

const dash = readEnv(`${MAIN}/dashboard/.env.local`);
const root = readEnv(`${MAIN}/.env`);
const SB = dash.NEXT_PUBLIC_SUPABASE_URL;
const KEY = dash.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = root.GARDEN_INBOUND_WEBHOOK_SECRET;
if (!SB?.includes(GARDEN_DB)) throw new Error(`refusing: ${SB} is not the garden database`);
if (!KEY || !SECRET) throw new Error('missing SUPABASE_SERVICE_ROLE_KEY or GARDEN_INBOUND_WEBHOOK_SECRET');

async function db(query) {
  const r = await fetch(`${SB}/rest/v1/${query}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`${query.split('?')[0]}: ${r.status} ${await r.text()}`);
  return r.json();
}
const inList = (ids) => `(${[...new Set(ids)].map((id) => `"${id}"`).join(',')})`;

async function ensureOllama() {
  const up = () => fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  if (await up()) return;
  const exe = path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Ollama/ollama.exe');
  spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await up()) return;
  }
  throw new Error('Ollama did not come up on 127.0.0.1:11434');
}

// The first installed model in MODELS plays the people. If none is, this blocks until the last
// one is pulled: hours on a slow line, and Task Scheduler starts no second run meanwhile.
async function ensureModel() {
  const tags = await (await fetch(`${OLLAMA}/api/tags`)).json();
  const have = MODELS.find((name) => tags.models?.some((m) => m.name === name));
  if (have) return have;
  const MODEL = MODELS.at(-1);
  console.log(`  pulling ${MODEL}...`);
  // Streamed: with stream:false Ollama sends nothing until the end and Node's fetch gives up after 5 minutes.
  const r = await fetch(`${OLLAMA}/api/pull`, { method: 'POST', body: JSON.stringify({ model: MODEL, stream: true }) });
  if (!r.ok) throw new Error(`ollama pull ${r.status} ${await r.text()}`);
  let last = '';
  for await (const chunk of r.body) last = Buffer.from(chunk).toString().trim().split('\n').pop() || last;
  if (!last.includes('"success"')) throw new Error(`ollama pull ended with ${last.slice(0, 200)}`);
  return MODEL;
}

async function gather() {
  const [settings] = await db('app_settings?select=test_mode,test_email');
  if (!settings?.test_mode || !settings.test_email) throw new Error('refusing: garden test_mode is off or test_email unset');
  const since = new Date(Date.now() - 2 * 86400e3).toISOString();
  const orders = (await db(`orders?select=id,order_name,tags,locale,buyer_name,buyer_email,recipient_name,delivery_address,delivery_at,greeting&created_at=gte.${since}&or=(order_name.like.*GARDEN-*,tags.like.*GARDEN*)`))
    .filter(isGardenOrder);
  if (!orders.length) return { settings, orders: new Map(), comms: [], florists: new Map() };
  // A failed send still counts as received: the pretend person stands in for whoever the
  // garden meant to reach, and the failure itself is already on the communications row.
  const comms = await db(`communications?select=id,created_at,audience,kind,order_id,florist_id,subject,body,rfc_message_id,provider_message_id&channel=eq.email&status=in.(sent,failed)&audience=in.(florist,client)&order_id=in.${inList(orders.map((o) => o.id))}`);
  const floristIds = comms.map((c) => c.florist_id).filter(Boolean);
  const florists = new Map(
    (floristIds.length ? await db(`florists?select=id,name,email,place_id&id=in.${inList(floristIds)}`) : []).map((f) => [f.id, f]),
  );
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const eligible = comms.filter((c) =>
    c.audience === 'client'
      ? isGardenClient(byOrder.get(c.order_id)?.buyer_email, settings.test_email)
      : florists.has(c.florist_id) && isGardenFlorist(florists.get(c.florist_id)),
  );
  return { settings, orders: byOrder, comms: eligible, florists };
}

const LANG = { es: 'Spanish', en: 'English', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch' };

async function writeReply(model, item, order, florist) {
  const { persona, comm } = item;
  const lang = LANG[persona.lang === 'order' ? (order.locale ?? 'en').slice(0, 2) : persona.lang] ?? 'English';
  const who = persona.role === 'florist'
    ? `You are the florist shop "${florist.name}". Facundo, a flower delivery company, sends you orders to make and deliver.`
    : `You are ${order.buyer_name ?? 'a customer'}, who ordered flowers from Facundo for ${order.recipient_name ?? 'someone'}.`;
  const facts = persona.role === 'florist'
    ? `Order ${order.order_name}, deliver to ${formatAddress(order.delivery_address)}, on ${order.delivery_at}.`
    : `Your order ${order.order_name}: recipient ${order.recipient_name}, address ${formatAddress(order.delivery_address)}, delivery ${order.delivery_at}, card message "${order.greeting ?? ''}".`;
  const prompt = [
    `${who} This is a test with invented people; play your part naturally.`,
    `How you write: ${persona.brief}`,
    `What you know: ${facts}`,
    `You just received this email from Facundo:\nSubject: ${comm.subject ?? ''}\n${(comm.body ?? '').slice(0, 1500)}`,
    `Write only the body of your reply email, in ${lang}, at most 4 sentences. No subject line, no placeholders, never say you are an AI.`,
  ].join('\n\n');
  // For the thinking model, think:true keeps the reasoning in message.thinking so content is only
  // the reply; with think:false it still reasoned, inline and cut off before </think>, and that
  // leaked into the garden on 2026-10-13. Its reasoning alone can pass 2000 tokens. Streamed,
  // because a non-streamed answer over 5 minutes trips Node fetch's header timeout.
  const thinks = THINKS.has(model);
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model, stream: true, ...(thinks ? { think: true } : {}),
      options: { num_predict: thinks ? 6000 : 400 },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20 * 60000),
  });
  if (!r.ok) throw new Error(`ollama ${r.status} ${await r.text()}`);
  let content = '';
  let doneReason = null;
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const j = JSON.parse(line);
      content += j.message?.content ?? '';
      if (j.done) doneReason = j.done_reason;
    }
  }
  if (doneReason === 'length') throw new Error('ollama ran out of tokens before the reply');
  const text = stripThinking(content);
  if (!text) throw new Error('ollama returned an empty reply');
  return text;
}

async function inject(item, order, florist, text) {
  const { comm, eventId } = item;
  const fromAddr = comm.audience === 'client' ? order.buyer_email : florist.email;
  const fromName = comm.audience === 'client' ? order.buyer_name : florist.name;
  const msgId = comm.rfc_message_id ?? `<${comm.provider_message_id}@resend.dev>`;
  const payload = JSON.stringify({
    type: 'email.received',
    data: {
      email_id: eventId,
      from: `${fromName} <${fromAddr}>`,
      to: [`reply@${msgId.split('@')[1]?.replace('>', '') ?? 'fc.example.com'}`],
      subject: /^re:/i.test(comm.subject ?? '') ? comm.subject : `Re: ${comm.subject ?? ''}`,
      text,
      headers: { 'in-reply-to': msgId, references: msgId },
    },
  });
  const r = await fetch(`${GARDEN_DASHBOARD}/api/webhooks/resend-inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...svixHeaders(eventId, payload, SECRET) },
    body: payload,
  });
  return `${r.status} ${(await r.text()).slice(0, 80)}`;
}

async function main() {
  const personas = parsePersonas(fs.readFileSync(path.join(HERE, 'personas.txt'), 'utf8'));
  const { orders, comms, florists } = await gather();
  const prior = (await db(`conversation_messages?select=provider_event_id&direction=eq.in&provider_event_id=like.${EVENT_PREFIX}:*`)).map((m) => m.provider_event_id);
  const plan = planReplies(comms, prior, personas, Date.now()).slice(0, SAY ? 1 : MAX_PER_RUN);
  console.log(`${new Date().toISOString()} garden orders=${orders.size} eligible emails=${comms.length} replies due=${plan.length}${DRY ? ' (dry run)' : ''}`);
  if (!plan.length) return;
  let model = null;
  if (!SAY) {
    await ensureOllama();
    model = await ensureModel();
  }
  for (const item of plan) {
    const order = orders.get(item.comm.order_id);
    const florist = florists.get(item.comm.florist_id);
    try {
      const text = SAY ?? await writeReply(model, item, order, florist);
      const result = DRY ? 'not sent' : await inject(item, order, florist, text);
      console.log(`  ${order.order_name} ${item.persona.id} (${model ?? 'fixed text'}) -> ${item.comm.kind}: ${result}\n    ${text.replace(/\n/g, ' ')}`);
    } catch (e) {
      console.log(`  ${order.order_name} ${item.persona.id}: FAILED ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} actors run failed: ${e.message}`);
  process.exitCode = 1;
});
