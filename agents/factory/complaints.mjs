// Pure half of the complaint input (Jessica's desk, item 2 in the garden-1.2
// README): customer complaints from Octocom, or from a CSV/JSON export of it,
// become alerts (factory_alerts, source 'complaint') on a general rule. One
// complaint is never a card: the sweep opens, closes and reopens the rule's
// card by CARD_LIFE in general-rules.mjs, like every other alert. A complaint
// no rule covers is an alert on no rule (match 'none'): listed for the owner as
// a maybe-product-change, never a card. Money complaints land on Jessica's
// rule, whose card stays with a person.
// No I/O: complaint-intake.mjs is the I/O half.

import { NEEDS_PLACING } from "../../dashboard/lib/cxAttentionRules.ts";
import { ruleIndex } from "./general-rules.mjs";

// ---- Reading a complaint ---------------------------------------------------------

/** RFC 4180 CSV: quoted fields may hold commas, "" and line breaks. First row is the header.
 * trimStart also drops a byte-order mark (Excel exports start with one). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const src = String(text).trimStart().replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter((r) => r.some((f) => f.trim()));
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** The first 6-9 digit number standing on its own: '#1234567', 'FC-1234567', 'order 1234567'. */
export function orderNumberOf(s) {
  return String(s ?? "").match(/(?:^|\D)(\d{6,9})(?!\d)/)?.[1] ?? null;
}

/** A date with no zone is read as UTC, so the same export gives the same time on any machine. */
function isoDate(s) {
  const v = String(s ?? "").trim();
  if (!v) return null;
  const local = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v);
  const t = Date.parse(local ? (v.length === 10 ? `${v}T00:00:00Z` : `${v.replace(" ", "T")}Z`) : v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const field = (r, names) => names.map((n) => r[n]).find((v) => v != null && String(v).trim() !== "");
const hash = (s) => { let h = 5381; for (const ch of s) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return h.toString(36); };

/** One export row -> {ref, source, order_number, text, received_at}, or {error} when it cannot count.
 * Without an id the ref is a hash of the row, so reimporting the file never counts it twice. */
export function complaintFromRow(r, source) {
  const text = String(field(r, ["complaint", "text", "message", "body", "description"]) ?? "").trim();
  const received_at = isoDate(field(r, ["date", "received_at", "created_at", "createdat"]));
  const order_number = orderNumberOf(field(r, ["order", "order_number", "order_name", "order_id"])) ?? orderNumberOf(text);
  const id = field(r, ["id", "ref", "ticket", "conversation_id"]);
  const ref = `${source}:${id ?? hash(`${order_number}|${received_at}|${text}`)}`;
  if (!text) return { ref, error: "no text" };
  if (!received_at) return { ref, error: "no date" };
  return { ref, source, order_number, received_at, text };
}

const QUOTE_START = /^(On .+wrote:|El .+escribi[oó]:|Am .+schrieb.*:|Le .+a écrit :|Il giorno .+ha scritto:|-{2,}\s*Original Message|From: |De: |Von: |>)/m;

/** One Octocom conversation (agents/knowledge/sources.mjs) -> the customer's own words. */
export function complaintFromOctocom(c) {
  const text = (c.messages ?? [])
    .filter((m) => m.sender === "customer")
    .map((m) => String(m.text ?? "").split(QUOTE_START)[0].trim())
    .filter(Boolean)
    .join("\n\n");
  const received_at = isoDate(c.createdAt ?? c.created_at ?? c.updatedAt);
  if (!text || !received_at) return null;
  return { ref: `octocom:conversation:${c.id}`, source: "octocom", order_number: orderNumberOf(text), received_at, text };
}

/** What we keep of the customer's words: no email or phone, at most 280 characters. */
export function redact(text) {
  const t = String(text ?? "")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 280 ? `${t.slice(0, 279)}…` : t;
}

// ---- Which general rule a complaint lands on -------------------------------------
// First match wins, so the order matters: money before anything else, "never
// arrived" before "says delivered". en/es/de/fr/it, the store's languages.
// rule null: no general rule covers it, a maybe-product-change for the owner.

export const TOPICS = [
  ["charged-wrong", "pay-exactly-owed", /charged (me )?twice|double[- ]charged?|overcharg|refund|money back|reembols|devoluci[oó]n|cobr(ado|aron) (dos veces|de m[aá]s)|r[uü]ckerstatt|doppelt (belastet|abgebucht)|rembours|rimbors/i],
  ["never-arrived", "accepted-gets-delivered", /never (arrived|came|got there|delivered)|(has|have|was|were|did)(n't| not)( yet)?( been)? (arrive|arrived|delivered|receive|received)|not (been )?delivered|no (ha|han) llegado|nunca lleg|no lleg[oó]|nicht (an)?gekommen|nicht geliefert|nie angekommen|jamais (re[çc]u|arriv)|pas (été )?livr|pas re[çc]u|mai arrivat|non (sono |è )?(mai )?arrivat|non consegnat/i],
  ["late", "accepted-gets-delivered", /\blate\b|delayed|wrong day|day after|tarde|retras|d[ií]a despu[eé]s|versp[äa]tet|zu sp[äa]t|en retard|in ritardo/i],
  ["wrong-flowers", "photo-proves-delivery", /wrong (flowers|bouquet|product|item|arrangement)|not what (i|we) ordered|different (flowers|bouquet)|nothing like|wilt|\bdead\b|dying|droop|smaller than|marchit|mustia|no (era|es) lo que|welk|nicht (das|was) (ich )?bestellt|fan[ée]e?s?\b|pas ce que|appassit/i],
  ["wrong-address", "order-on-map", /wrong (address|house|street|city|town)|direcci[oó]n (equivocada|incorrecta|err[oó]nea)|falsche adresse|mauvaise adresse|indirizzo sbagliato/i],
  ["order-lost", "order-in-clean", /(order|pedido|bestellung|commande|ordine) (was |fue |wurde )?(cancel|storniert|annul)|no (order )?confirmation|never (got|received) (a|the|any) confirmation|sin confirmaci|keine (bestell)?best[äa]tigung|pas de confirmation/i],
  ["status-wrong", "shopify-agrees", /(says|said|marked|shows?|showing)( as)? delivered|tracking|marcado como entregado|als zugestellt|marqu[ée] (comme )?livr/i],
  ["no-reply", "someone-watching", /no(body| one) (has )?(answered|replied|responded|got back)|no (answer|reply|response) (from|to)|never (heard back|got a reply)|sin respuesta|nadie (me )?(contest|respond)|keine antwort|niemand (hat )?geantwortet|pas de r[ée]ponse|personne ne r[ée]pond|nessuna risposta/i],
  ["price", null, /expensive|pric(e|ey)|\bcaro\b|precio|teuer|preis|\bcher\b|\bprix\b|costos|prezzo|delivery (fee|cost|charge)|shipping (fee|cost)|gastos de env/i],
  ["website", null, /website|web ?site|checkout|the app\b|p[aá]gina web|webseite|site web|\bsito\b/i],
  ["range", null, /more (choice|options|variety)|no (vegan|vase|chocolate)|catalog|selection|sold out|agotad|ausverkauft|[ée]puis[ée]/i],
];

const COMPLAINT_WORDS = /complain|disappoint|unacceptable|terrible|awful|horrible|worst|angry|upset|unhappy|queja|reclam|decepcion|inaceptable|fatal|beschwer|entt[äa]usch|unversch[äa]mt|plainte|d[ée][çc]u|inacceptable|delus|vergogn/i;

/** Words a rule uses that also turn up in ordinary questions and greetings:
 * "deliver late afternoon?", "the tracking link please", "your refund policy?",
 * "Buenas tardes". Alone they make no complaint, and they never outrank a
 * clearer topic in the same message. */
const ORDINARY_WORDS = /\blate\b|\btardes?\b|tracking|refund|money back|reembols\w*|devoluci[oó]n|r[uü]ckerstatt\w*|rembours\w*|rimbors\w*/gi;
/** "late" said about a delivery that happened is a complaint on its own. */
const LATE_DELIVERY = /\b(arrived|came|delivered|got there|turned up|showed up)( \w+){0,3} late\b|\b(was|were) late\b|\blate (delivery|arrival)\b|\blleg(aron|[oó])( \w+){0,3} tarde\b/i;
const withoutOrdinary = (text) => String(text).replace(ORDINARY_WORDS, " ");

/** Octocom holds every customer conversation; only a complaint counts. A rule's
 * words are enough (all but the ordinary ones above); a product topic (a price
 * question) needs a complaint word too. */
export function isComplaint(text) {
  const plain = withoutOrdinary(text);
  return TOPICS.some(([, rule, re]) => rule && re.test(plain)) || LATE_DELIVERY.test(text) || COMPLAINT_WORDS.test(text);
}

const DELIVERY_TOPICS = ["never-arrived", "late"];

/** text + the linked order (or null) -> {topic, rule, situation, why}. For
 * "never arrived" and "late" the order says which rule broke: nobody near,
 * nobody answered the offer, or the florist accepted and did not deliver.
 * situation: the exact lifecycle.ts situation when the order's state names one. */
export function classifyComplaint(text, order) {
  const plain = withoutOrdinary(text);
  const hit = TOPICS.find(([topic, , re]) => re.test(plain) || (topic === "late" && LATE_DELIVERY.test(text)))
    || TOPICS.find(([, , re]) => re.test(text));
  if (!hit) return { topic: "other", rule: null, situation: null, why: "no general rule's words; maybe a product change" };
  const [topic, rule, re] = hit;
  const why = `said "${(text.match(re) ?? text.match(LATE_DELIVERY) ?? plain.match(re))[0]}"`;
  if (!DELIVERY_TOPICS.includes(topic) || !order) return { topic, rule, situation: null, why: rule ? why : `${why}; maybe a product change` };
  const state = `order ${order.order_name ?? ""} is ${order.status}${order.escalation_reason ? ` (${order.escalation_reason})` : ""}`.replace("  ", " ");
  if (order.status === "escalated" && order.escalation_reason === "pool_exhausted") return { topic, rule: "area-has-florists", situation: "match-none", why: `${why}; ${state}` };
  if (NEEDS_PLACING.includes(order.status) || order.status === "reaching_out") return { topic, rule: "offer-gets-answer", situation: null, why: `${why}; ${state}` };
  return { topic, rule, situation: topic === "late" ? "deliver-late" : null, why: `${why}; ${state}` };
}

// ---- A complaint -> an alert -----------------------------------------------------

/**
 * One classified complaint -> a factory_alerts row (general-rules.mjs's shape).
 * The key is the exact situation when the order's state names one (match
 * 'exact', as ruleIndex places it); else the rule the words picked (match
 * 'near', no model call); else the topic, on no rule (match 'none').
 * The id is the complaint's own ref, not alertId's order id: two customers
 * complaining about one order are two complaints, a complaint with no order
 * must not merge with every other one, and a rerun after the order moved on
 * is still the same alert (placed once, never twice). placed_at and last_seen_at are
 * when the customer wrote, so an old export never counts as this week's.
 * @param c {ref, source, received_at, order_number, text}
 * @param order the linked garden order {id, order_name} or null
 * @param placedDay the Madrid day of received_at (the run half computes it)
 */
export function complaintAlert(c, order, { topic, rule, situation, why }, placedDay) {
  const exact = situation && ruleIndex().get(situation)?.id === rule;
  const key = exact ? situation : rule ?? topic;
  const orderName = order?.order_name ?? (c.order_number ? `#${c.order_number}` : null);
  return {
    alert_id: `complaint:${c.ref}`,
    source: "complaint",
    key,
    label: `${orderName ? `${orderName}: ` : ""}${redact(c.text)}`.slice(0, 300),
    ref: { order_id: order?.id ?? null, order_name: orderName, complaint_ref: c.ref, from: c.source, topic },
    rule_id: rule,
    match: !rule ? "none" : exact ? "exact" : "near",
    why: exact ? null : `customer complaint: ${why}`,
    cost_usd: 0,
    placed_at: c.received_at,
    last_seen_at: c.received_at,
    placed_day: placedDay,
  };
}
