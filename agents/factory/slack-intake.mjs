// Slack intake, pure half (docs/agent-factory/human-loop.md, "Slack intake").
// No I/O: slack-intake-run.mjs reads Slack and the garden and feeds this.
//
// The ops team writes fast in #cx-desk: an order number and a few words. For
// each message the intake finds the order, reads its state, and ends in one of:
//   alert      one alert on a general rule (factory_alerts, source 'slack');
//              the sweep opens, closes and reopens the rule's card by
//              CARD_LIFE in general-rules.mjs, like every other alert
//   judgement  an "it depends" call that is the team's, not a fix
//   ask        ONE short question back (which order, or which of 2-3 things)
//   pass       still unclear after that one question: "I've passed this to the owner."
// Replies are one plain line (.claude/rules/slack-roles.md): never code,
// files, errors or how anything works.

import { IN_FULFILMENT } from "../../dashboard/lib/cxAttentionRules.ts";
import { alertId, ruleIndex } from "./general-rules.mjs";

export const INTAKE = Object.freeze({
  /** Only the ops desk feeds the factory; #marketing and #coo are change requests. */
  channel: "cx-desk",
  /** A question nobody answers within this many hours is passed to the owner. */
  answerWaitHours: 24,
  /** At most this many things to choose from, plus "something else". */
  maxChoices: 3,
});

export const PASS_TO_OWNER = "I've passed this to the owner.";

// How the ops team would say each rule broke, for choices and replies.
export const RULE_LABEL = {
  "order-in-clean": "the order came in wrong",
  "order-on-map": "wrong address or place",
  "area-has-florists": "no florist nearby",
  "only-ready-shops": "the wrong shop got it",
  "offer-reaches-shop": "the shop never got the offer",
  "offer-gets-answer": "no shop answered",
  "accepted-gets-delivered": "late or not delivered",
  "photo-proves-delivery": "the delivery photo",
  "pay-exactly-owed": "a payment",
  "shopify-agrees": "Shopify shows something else",
  "florist-questions-answered": "a florist's question",
  "recruiting-honest-once": "a recruiting message",
  "someone-watching": "nobody picked it up, or sign-in",
};

// Words, Spanish and English, that point at a rule. Ambiguity is fine: two
// rules in one message turn into a choice, never a guess.

// A word must stand alone. JS's \b is ASCII-only ("llegó" would never end a
// word), so the edges are any letter or digit, in any script.
const w = (src) => new RegExp(String.raw`(?<![\p{L}\d])(?:${src})(?![\p{L}\d])`, "u");
const L = String.raw`\p{L}*`;

const WORDS = [
  ["photo-proves-delivery", w(String.raw`fotos?|photos?|imagen|picture|pic`)],
  ["pay-exactly-owed", w(String.raw`pag(o|os|ar|ado|ada)|pay(ment|out)?s?|paid|cobr${L}|dinero|money|factura|invoice|refunds?|reembols${L}`)],
  ["shopify-agrees", w(String.raw`shopify`)],
  ["order-on-map", w(String.raw`direcci[oó]n|address|mapa?|c[oó]digo postal|postcode|zip|ubicaci[oó]n|location|coordenadas`)],
  ["area-has-florists", w(String.raw`no hay (florister[ií]as?|floristas?|tiendas?)|ning[uú]n florist${L}|sin florist${L}|no florists?|nobody (near|in range)|no shops? (near|in)`)],
  ["offer-reaches-shop", w(String.raw`no le (ha )?lleg${L}|(didn'?t|never) (get|got|receive|received) the (offer|email|sms)|e-?mails?|correo|sms|idioma|language|rebot${L}|bounced?`)],
  ["offer-gets-answer", w(String.raw`no (contesta|responde|acepta)|sin respuesta|no answer|not answering|no reply|nadie (acepta|contesta|responde)|nobody (accepts?|answers?|replies)|rechaz${L}|declin${L}|caduc${L}|expired?`)],
  ["accepted-gets-delivered", w(String.raw`tarde|late|retras${L}|no (se )?(ha )?entreg${L}|not delivered|undelivered|no est[aá] en casa|nobody home|nadie en casa`)],
  ["florist-questions-answered", w(String.raw`preguntas?|questions?|dudas?|asistente|assistant|nadie le responde|no one replied`)],
  ["only-ready-shops", w(String.raw`duplicad[ao]s?|duplicates?|tienda cerrada|closed shop|no es (una )?florister[ií]a|not a florist`)],
  ["order-in-clean", w(String.raw`incomplet[oa]|incomplete|falta(n)? (el|la|los|un|una)|missing (item|product)s?|editad[oa]|edited|cancelad[oa] por el cliente|customer cancell?ed`)],
  ["recruiting-honest-once", w(String.raw`recruit${L}|reclut${L}|captaci[oó]n|join link|enlace de alta`)],
  ["someone-watching", w(String.raw`nadie lo (vio|mir[oó])|nobody (saw|noticed)|login|iniciar sesi[oó]n|sign[- ]?in|magic link|enlace m[aá]gico`)],
];

const DECISION = w(String.raw`puede|pueden|podemos|dejamos|le decimos|vale|ok|okay|can|could|should|shall|may|do we`);

/** Slack markup out: mentions, links (keeping the label), channel refs. */
export function cleanSlackText(text) {
  return String(text ?? "")
    .replace(/<@[A-Z0-9]+>/g, " ")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<[^>|]+\|([^>]+)>/g, "$1")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Order names in a message: "#1234567", "#F001", or a bare 5-8 digit number
 * ("pedido 1234567"). Longer runs are phone numbers, not orders. */
export function orderNames(text) {
  const out = [];
  for (const m of String(text).matchAll(/(?<![\w#])#?([A-Z]?\d{3,8})(?![\d])/gi)) {
    const [whole, body] = m;
    const hashed = whole.startsWith("#");
    if (!hashed && !/^\d{5,8}$/.test(body)) continue;
    const name = `#${body.toUpperCase()}`;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function parseOpsMessage(raw) {
  const text = cleanSlackText(raw);
  const lower = text.toLowerCase();
  const rules = WORDS.filter(([, re]) => re.test(lower)).map(([id]) => id);
  const asks = /\?\s*$|¿/.test(text) && DECISION.test(lower);
  return { text, orderNames: orderNames(text), rules, judgement: asks && !rules.length };
}

/** What the order's own state says broke, with the situation id
 * (dashboard/lib/lifecycle.ts) when it is that exact. */
export function factRules(order, now = Date.now()) {
  if (!order) return [];
  const out = [];
  const add = (rule, situation) => { if (!out.some((r) => r.rule === rule)) out.push({ rule, situation }); };
  if (order.status === "escalated" && order.escalation_reason === "pool_exhausted") add("area-has-florists", "match-none");
  if (order.status === "escalated" && ["out_of_time", "wave_ceiling"].includes(order.escalation_reason)) add("offer-gets-answer", "reachout-timeout");
  if (["declined", "expired"].includes(order.offer) && !IN_FULFILMENT.includes(order.status)) add("offer-gets-answer", null);
  if (IN_FULFILMENT.includes(order.status) && order.delivery_at && Date.parse(order.delivery_at) < now) add("accepted-gets-delivered", "deliver-late");
  if (["fail", "review"].includes(order.photo)) add("photo-proves-delivery", "deliver-bad-photo");
  if (order.waiting_conversations > 0) add("florist-questions-answered", "x-support-thread-unanswered");
  return out;
}

const DEFAULT_CHOICES = ["offer-gets-answer", "accepted-gets-delivered", "photo-proves-delivery"];

const orderQuestion = () => "Okay, I'm on it. Which order is this? Send the number, like #1234567.";
const ruleQuestion = (name, choices) =>
  `Okay, I'm on it. What went wrong with ${name}? ${choices.map((r, i) => `${i + 1} ${RULE_LABEL[r]}`).join(" · ")} · ${choices.length + 1} something else`;

/**
 * One message (or one message plus the answer to our one question) -> outcome.
 * @param {{parsed: ReturnType<typeof parseOpsMessage>, order: object|null, asked?: {about: "order"|"rule", choices?: string[]}|null, answer?: string|null, now?: number}} input
 */
export function decide({ parsed, order, asked = null, answer = null, now = Date.now() }) {
  if (!order) {
    if (asked) return { kind: "pass", why: parsed.orderNames.length ? `no order ${parsed.orderNames.join(", ")} in the garden` : "no order number, even after asking", reply: PASS_TO_OWNER };
    return { kind: "ask", question: { about: "order" }, reply: orderQuestion() };
  }
  const facts = factRules(order, now);
  const situationFor = (rule) => facts.find((f) => f.rule === rule)?.situation ?? null;
  const alert = (rule, match) => ({ kind: "alert", rule, situation: situationFor(rule), match, reply: `${asked ? "Thanks" : "Okay, I'm on it"}: noted for ${order.order_name} (${RULE_LABEL[rule]}).` });

  if (asked?.about === "rule") {
    const rule = readChoice(asked.choices ?? [], answer);
    if (rule) return alert(rule, "answer");
    return { kind: "pass", why: `answer did not pick one of: ${(asked.choices ?? []).join(", ")}`, reply: PASS_TO_OWNER };
  }
  if (parsed.judgement) return { kind: "judgement", reply: `Okay, I'm on it. That's the team's call; it's on the team's list for ${order.order_name}.` };

  const words = parsed.rules;
  const factIds = facts.map((f) => f.rule);
  if (words.length === 1) return alert(words[0], "words");
  if (!words.length && factIds.length === 1) return alert(factIds[0], "facts");
  const both = words.filter((r) => factIds.includes(r));
  if (both.length === 1) return alert(both[0], "words+facts");

  const choices = (words.length ? words : factIds.length ? factIds : DEFAULT_CHOICES).slice(0, INTAKE.maxChoices);
  if (asked) return { kind: "pass", why: "still unclear after one question", reply: PASS_TO_OWNER };
  return { kind: "ask", question: { about: "rule", choices }, reply: ruleQuestion(order.order_name, choices) };
}

/** The rule an answer picks: its number, or words that point at only one of
 * the choices. "Something else" (the last number) or nothing clear: null. */
export function readChoice(choices, answer) {
  const text = cleanSlackText(answer).toLowerCase();
  const n = text.match(/^\s*(\d)\b/);
  if (n) return choices[Number(n[1]) - 1] ?? null;
  const hit = choices.filter((r) => text.includes(RULE_LABEL[r]) || WORDS.find(([id]) => id === r)?.[1].test(text));
  return hit.length === 1 ? hit[0] : null;
}

/** Whether our one question has waited too long for an answer. */
export function questionExpired(askedAt, now = Date.now()) {
  return now - Date.parse(askedAt) > INTAKE.answerWaitHours * 3600_000;
}

/**
 * An alert outcome -> a factory_alerts row (general-rules.mjs's shape, without
 * the placed_at/last_seen_at/placed_day the run half stamps). The key is the
 * exact situation when the order's state names one, placed by ruleIndex like
 * every other alert; else the rule itself, placed by what the team said
 * (match 'near': no model call, the words or their answer picked the rule).
 * The id is alertId's: the same order reported again on the same thing is the
 * same alert, seen again, not a new one.
 */
export function slackAlert({ outcome, order, text, channel, ts, permalink = null }) {
  const exact = outcome.situation && ruleIndex().get(outcome.situation)?.id === outcome.rule;
  const signal = {
    source: "slack",
    key: exact ? outcome.situation : outcome.rule,
    label: `${order.order_name}: ${text}`.slice(0, 300),
    ref: { order_id: order.id, order_name: order.order_name, channel, ts, permalink },
  };
  return {
    alert_id: alertId(signal),
    ...signal,
    rule_id: outcome.rule,
    match: exact ? "exact" : "near",
    why: exact ? null : `ops team in Slack (${outcome.match})`,
    cost_usd: 0,
  };
}
