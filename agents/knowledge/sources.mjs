// Fetches the three knowledge sources into .cache/ (gitignored: conversations hold customer data).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache');
export const BUSINESS = 'facundo';
const CONDITIONS_URL = 'https://www.fc.example.com/pages/conditions-of-purchase';

const octocom = async (p, opts = {}) => {
  const base = process.env.OCTOCOM_BASE_URL.replace(/\/$/, '') + '/rest/v1';
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(base + p, { ...opts, headers: { 'X-API-Key': process.env.OCTOCOM_API, 'content-type': 'application/json' } });
    if (r.status === 429 && attempt < 5) { await new Promise((s) => setTimeout(s, 15_000)); continue; }
    if (!r.ok) throw new Error(`octocom ${r.status} ${p}`);
    return r.json();
  }
};

const decode = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

export async function conditionsPage() {
  const html = await (await fetch(CONDITIONS_URL, { headers: { 'user-agent': 'Mozilla/5.0 Facundo-KB' } })).text();
  const start = html.indexOf('<h2>Delivery cost</h2>');
  const end = html.indexOf('</div>', html.indexOf('<h2>Product substitution policy</h2>'));
  if (start < 0 || end < 0) throw new Error('conditions page layout changed: section markers not found');
  return html.slice(start, end).split('<h2>').slice(1).map((part) => {
    const [title, body] = part.split('</h2>');
    return { source: 'conditions_page', ref: `${CONDITIONS_URL}#${decode(title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title: decode(title), content: decode(body), language: 'en', version: null };
  });
}

export async function octocomArticles() {
  const list = [];
  for (let page = 1; ; page++) {
    const r = await octocom(`/articles?businessSlug=${BUSINESS}&page=${page}`);
    list.push(...r.data);
    if (!r.pagination?.hasMore) break;
  }
  const out = [];
  for (const a of list.filter((x) => x.isActive)) {
    const { data } = await octocom(`/articles/${a.id}?businessSlug=${BUSINESS}`);
    out.push({ source: 'octocom_article', ref: `octocom:article:${a.id}`, title: data.title, content: decode(data.content ?? ''), language: data.language ?? null, version: data.updatedAt, isPublic: data.isPublic });
  }
  return out;
}

const senders = (c) => (c.messages ?? []).filter((m) => m.sender === 'customer' || m.isSent !== false).map((m) => m.sender);

/** customer -> bot -> CX agent -> customer again, in that order. */
export function isCustomerBotAgentCustomer(c) {
  const s = senders(c);
  const customer = s.indexOf('customer');
  const bot = s.indexOf('bot', customer);
  const agent = bot < 0 ? -1 : s.indexOf('agent', bot);
  return customer >= 0 && bot > customer && agent > bot && s.indexOf('customer', agent) > agent;
}

export async function octocomConversations({ from, to }) {
  const ids = [];
  for (let page = 1; ; page++) {
    const r = await octocom(`/conversations?businessSlug=${BUSINESS}&handedOff=true&spam=false&limit=200&page=${page}&startDate=${from}&endDate=${to}`);
    ids.push(...r.data.map((c) => c.id));
    if (!r.pagination?.hasMore) break;
  }
  const details = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await octocom('/conversations/bulk', { method: 'POST', body: JSON.stringify({ ids: ids.slice(i, i + 200) }) });
    details.push(...r.data.filter((c) => c.businessSlug === BUSINESS));
  }
  return { handedOff: details.length, matching: details.filter(isCustomerBotAgentCustomer) };
}

export function save(name, data) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, name), JSON.stringify(data, null, 1));
}
export const load = (name) => JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'));

/** Every row the knowledge base holds, one text each. Q&A entries keep only de-identified fields. */
export function documents() {
  const docs = [...load('conditions.json'), ...load('articles.json')]
    .filter((d) => d.content.trim())
    .map((d) => ({ ...d, authority: d.source === 'octocom_article' ? 1 : 2, reviewed: true, outcome: null, text: `${d.title}\n\n${d.content}` }));
  for (const e of load('distilled.json').filter((x) => x.reusable && x.cx_answer?.trim())) {
    docs.push({
      source: 'cx_conversation', ref: `octocom:conversation:${e.conversationId}`, title: e.topic,
      language: e.customer_language, version: e.closedAt, authority: 3, reviewed: false, outcome: e.outcome, isPublic: false,
      text: `${e.topic}\n\nCustomer: ${e.customer_question}\n\nHow CX answered: ${e.cx_answer}${e.policy_points.length ? `\n\nPolicy: ${e.policy_points.join(' ')}` : ''}`,
    });
  }
  return docs;
}
