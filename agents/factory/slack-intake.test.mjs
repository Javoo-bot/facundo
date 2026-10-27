// node --test agents/factory/slack-intake.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RULES, CARD_LIFE, DAY_MS, ruleCardPlan } from "./general-rules.mjs";
import {
  RULE_LABEL, PASS_TO_OWNER, INTAKE,
  cleanSlackText, orderNames, parseOpsMessage, factRules, decide, readChoice, questionExpired, slackAlert,
} from "./slack-intake.mjs";
import { runIntake, isOpsMessage } from "./slack-intake-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const now = Date.parse("2026-10-27T12:00:00Z");
const order = (extra = {}) => ({ id: "o1", order_name: "#1234567", status: "reaching_out", escalation_reason: null, delivery_at: null, offer: "sent", photo: null, waiting_conversations: 0, ...extra });

// ---- The pure half -----------------------------------------------------------------

test("order numbers come from #names and bare 5-8 digit numbers; phones, dates and times are not orders", () => {
  assert.deepEqual(orderNames("pedido 1234567 y #F001, otra vez #1234567"), ["#1234567", "#F001"]);
  assert.deepEqual(orderNames("llama al +34 600000001 el 2026-10-27 a las 10:30"), []);
  assert.deepEqual(orderNames("ref 1234"), []);
});

test("Slack markup is stripped: mentions go, link labels and channel names stay", () => {
  assert.equal(cleanSlackText("<@U0ABC> mira <https://x.example/o/1|#1234567> en <#C123|cx-desk> &amp; ya"), "mira #1234567 en #cx-desk & ya");
});

test("a few fast words land on the right general rule, in Spanish or English, accents included", () => {
  const rule = (t) => parseOpsMessage(t).rules;
  assert.deepEqual(rule("#1234567 la foto está borrosa"), ["photo-proves-delivery"]);
  assert.deepEqual(rule("1234567 no le llegó el aviso"), ["offer-reaches-shop"]);
  assert.deepEqual(rule("#1234567 nadie contesta"), ["offer-gets-answer"]);
  assert.deepEqual(rule("#1234567 llegó tarde"), ["accepted-gets-delivered"]);
  assert.deepEqual(rule("#1234567 wrong address"), ["order-on-map"]);
  assert.deepEqual(rule("#1234567 florist not paid"), ["pay-exactly-owed"]);
  assert.deepEqual(rule("#1234567 nadie lo miró"), ["someone-watching"]);
  assert.deepEqual(rule("#1234567 se picó"), [], "a word inside a word is not that word");
  assert.deepEqual(rule("#1234567 ok"), []);
});

test("a decision question with no problem words is the team's call, not a rule", () => {
  assert.equal(parseOpsMessage("#1234567 ¿puede entregar mañana?").judgement, true);
  assert.equal(parseOpsMessage("#1234567 can she deliver tomorrow?").judgement, true);
  assert.equal(parseOpsMessage("#1234567 ¿por qué la foto está mal?").judgement, false);
});

test("the order's own state names the rule when the words do not", () => {
  assert.deepEqual(factRules(order({ status: "escalated", escalation_reason: "pool_exhausted" })), [{ rule: "area-has-florists", situation: "match-none" }]);
  assert.deepEqual(factRules(order({ status: "in_production", delivery_at: "2026-10-27T09:00:00Z" }), now), [{ rule: "accepted-gets-delivered", situation: "deliver-late" }]);
  assert.deepEqual(factRules(order()), []);
});

test("every rule and situation the intake names exists", () => {
  const ids = RULES.map((r) => r.id);
  assert.deepEqual(Object.keys(RULE_LABEL).sort(), [...ids].sort());
  const lifecycle = readFileSync(join(here, "../../dashboard/lib/lifecycle.ts"), "utf8");
  for (const s of ["match-none", "reachout-timeout", "deliver-late", "deliver-bad-photo", "x-support-thread-unanswered"]) {
    assert.match(lifecycle, new RegExp(`id: "${s}"`), s);
    assert.ok(RULES.some((r) => r.members.includes(s)), `${s} sits under a general rule`);
  }
});

test("one clear message is one alert, with a one-line plain reply", () => {
  const out = decide({ parsed: parseOpsMessage("#1234567 nadie contesta"), order: order(), now });
  assert.deepEqual([out.kind, out.rule, out.match], ["alert", "offer-gets-answer", "words"]);
  assert.equal(out.reply, "Okay, I'm on it: noted for #1234567 (no shop answered).");
  assert.ok(!out.reply.includes("\n") && !/rule|card|factory|status|error/i.test(out.reply));
});

test("words and the order's state together settle a two-rule message without asking", () => {
  const out = decide({ parsed: parseOpsMessage("#1234567 la foto no llegó tarde"), order: order({ status: "in_production", delivery_at: "2026-10-27T09:00:00Z" }), now });
  assert.deepEqual([out.kind, out.rule, out.situation], ["alert", "accepted-gets-delivered", "deliver-late"]);
});

test("unclear: ONE short question with at most 3 choices plus 'something else'; unclear again: passed to the owner", () => {
  const parsed = parseOpsMessage("#1234567 fatal");
  const first = decide({ parsed, order: order(), now });
  assert.equal(first.kind, "ask");
  assert.ok(first.question.choices.length <= INTAKE.maxChoices);
  assert.match(first.reply, /^Okay, I'm on it\. What went wrong with #1234567\? 1 .* · 4 something else$/);
  const picked = decide({ parsed, order: order(), asked: first.question, answer: "2", now });
  assert.deepEqual([picked.kind, picked.rule, picked.match], ["alert", first.question.choices[1], "answer"]);
  assert.match(picked.reply, /^Thanks: noted for #1234567/);
  const other = decide({ parsed, order: order(), asked: first.question, answer: "4", now });
  assert.deepEqual([other.kind, other.reply], ["pass", PASS_TO_OWNER]);
});

test("no order number: ask which order once; still none: passed to the owner", () => {
  const parsed = parseOpsMessage("la florista no contesta");
  const ask = decide({ parsed, order: null, now });
  assert.deepEqual([ask.kind, ask.question.about], ["ask", "order"]);
  assert.equal(decide({ parsed, order: null, asked: ask.question, answer: "no sé", now }).kind, "pass");
});

test("an answer in words picks a choice only when it points at one", () => {
  const choices = ["offer-gets-answer", "accepted-gets-delivered", "photo-proves-delivery"];
  assert.equal(readChoice(choices, "la foto"), "photo-proves-delivery");
  assert.equal(readChoice(choices, "la foto y tarde"), null);
  assert.equal(readChoice(choices, "9"), null);
});

test("our question waits a day for an answer, then is passed on", () => {
  assert.equal(questionExpired("2026-10-26T13:00:00Z", now), false);
  assert.equal(questionExpired("2026-10-26T11:00:00Z", now), true);
});

test("a Slack alert is placed like any other: exact by the order's situation, else on the rule the team named", () => {
  const where = { channel: "C1", ts: "1.0", permalink: "https://x.slack.com/p1" };
  const late = order({ status: "in_production", delivery_at: "2026-10-27T09:00:00Z" });
  const exact = slackAlert({ outcome: decide({ parsed: parseOpsMessage("#1234567 llegó tarde"), order: late, now }), order: late, text: "llegó tarde", ...where });
  assert.deepEqual([exact.source, exact.key, exact.rule_id, exact.match, exact.alert_id], ["slack", "deliver-late", "accepted-gets-delivered", "exact", "slack:o1:deliver-late"]);
  const words = slackAlert({ outcome: decide({ parsed: parseOpsMessage("#1234567 nadie contesta"), order: order(), now }), order: order(), text: "nadie contesta", ...where });
  assert.deepEqual([words.key, words.rule_id, words.match], ["offer-gets-answer", "offer-gets-answer", "near"]);
  assert.match(words.why, /words/);
  assert.equal(words.ref.permalink, "https://x.slack.com/p1");
});

test("Slack alerts open a rule card only at CARD_LIFE's count, through the same plan as every alert", () => {
  const ago = (d) => new Date(now - d * DAY_MS).toISOString();
  const report = (i) => {
    const o = order({ id: `o${i}`, order_name: `#${i}0000` });
    const a = slackAlert({ outcome: decide({ parsed: parseOpsMessage("nadie contesta"), order: o, now }), order: o, text: "nadie contesta", channel: "C1", ts: `${i}.0` });
    return { ...a, placed_at: ago(i), last_seen_at: ago(i) };
  };
  const alerts = Array.from({ length: CARD_LIFE.openAlerts }, (_, i) => report(i + 1));
  assert.deepEqual(ruleCardPlan({ alerts: alerts.slice(1), cards: [], now }), []);
  const [p] = ruleCardPlan({ alerts, cards: [], now });
  assert.deepEqual([p.action, p.card.general_rule, p.card.source, p.card.evidence.count], ["open", "offer-gets-answer", "rule", CARD_LIFE.openAlerts]);
});

// ---- The handler, with a fake Slack and a fake garden ----------------------------------

function fakes({ messages = [], replies = {}, orders = [], items = [], bookmark = "1761500000.000000", failPost = false }) {
  const posted = [];
  const state = { bookmark, items: [...items], alerts: [] };
  const slack = {
    channelId: "C1", botUserId: "UBOT",
    history: async (oldest) => messages.filter((m) => Number(m.ts) > Number(oldest)),
    replies: async (ts) => replies[ts] ?? [],
    post: async (threadTs, text) => { if (failPost) throw new Error("Slack chat.postMessage: ratelimited"); posted.push({ threadTs, text }); return { ts: `${threadTs}9` }; },
    permalink: async (ts) => `https://x.slack.com/archives/C1/p${ts}`,
  };
  const garden = {
    bookmark: async () => state.bookmark,
    saveBookmark: async (ts) => { state.bookmark = ts; },
    pending: async () => state.items.filter((i) => i.state === "asked"),
    known: async (ts) => state.items.some((i) => i.ts === ts),
    findOrder: async (names) => names.map((n) => orders.find((o) => o.order_name === n)).find(Boolean) ?? null,
    saveItem: async (row) => { state.items = [...state.items.filter((i) => i.ts !== row.ts), row]; },
    saveAlert: async (row) => {
      const had = state.alerts.find((a) => a.alert_id === row.alert_id);
      if (had) had.last_seen_at = row.last_seen_at;
      else state.alerts.push(row);
    },
  };
  return { slack, garden, posted, state };
}

const msg = (ts, text, extra = {}) => ({ ts, text, user: "UOPS", ...extra });

test("the handler answers each ops message in its thread, writes one alert, and moves the bookmark", async () => {
  const f = fakes({
    messages: [msg("1761500001.000100", "#1234567 nadie contesta"), msg("1761500002.000100", "joined", { subtype: "channel_join" }), msg("1761500003.000100", "mine", { user: "UBOT" })],
    orders: [order()],
  });
  const done = await runIntake({ slack: f.slack, garden: f.garden, now, log: () => {} });
  assert.deepEqual(done, [{ ts: "1761500001.000100", kind: "alert", rule: "offer-gets-answer" }]);
  assert.deepEqual(f.posted, [{ threadTs: "1761500001.000100", text: "Okay, I'm on it: noted for #1234567 (no shop answered)." }]);
  assert.equal(f.state.alerts.length, 1);
  assert.deepEqual([f.state.alerts[0].alert_id, f.state.alerts[0].rule_id, f.state.alerts[0].placed_day], ["slack:o1:offer-gets-answer", "offer-gets-answer", "2026-10-27"]);
  assert.equal(f.state.alerts[0].ref.permalink, "https://x.slack.com/archives/C1/p1761500001.000100");
  assert.equal(f.state.bookmark, "1761500003.000100");
});

test("a rerun over the same messages counts nothing twice", async () => {
  const f = fakes({ messages: [msg("1761500001.000100", "#1234567 nadie contesta")], orders: [order()] });
  await runIntake({ slack: f.slack, garden: f.garden, now, log: () => {} });
  f.state.bookmark = "1761500000.000000"; // a retry that starts from the old bookmark
  await runIntake({ slack: f.slack, garden: f.garden, now, log: () => {} });
  assert.equal(f.state.alerts.length, 1);
  assert.equal(f.posted.length, 1);
});

test("a failed post saves nothing: no alert, no row, the bookmark stays", async () => {
  const f = fakes({ messages: [msg("1761500001.000100", "#1234567 nadie contesta")], orders: [order()], failPost: true });
  await assert.rejects(runIntake({ slack: f.slack, garden: f.garden, now, log: () => {} }), /ratelimited/);
  assert.deepEqual([f.state.alerts.length, f.state.items.length, f.state.bookmark], [0, 0, "1761500000.000000"]);
});

test("the one question is settled by the answer in its thread, reading the order again", async () => {
  const f = fakes({
    messages: [msg("1761500001.000100", "#1234567 fatal")],
    orders: [order()],
  });
  await runIntake({ slack: f.slack, garden: f.garden, now, log: () => {} });
  const asked = f.state.items[0];
  assert.equal(asked.state, "asked");
  f.slack.replies = async () => [msg("1761500001.000100", "#1234567 fatal"), msg(asked.reply_ts, "question", { user: "UBOT", bot_id: "B1" }), msg("1761500009.000100", "3")];
  await runIntake({ slack: f.slack, garden: f.garden, now, log: () => {} });
  assert.equal(f.state.items[0].state, "alert");
  assert.equal(f.state.alerts[0].match, "near");
  assert.match(f.state.alerts[0].why, /answer/);
  assert.equal(f.state.alerts[0].rule_id, asked.question.choices[2]);
});

test("a question nobody answers for a day is passed to the owner; a wrong order number too", async () => {
  const f = fakes({
    items: [{ channel: "C1", ts: "1761400000.000100", user_id: "UOPS", text: "#1234567 fatal", order_name: "#1234567", state: "asked", question: { about: "rule", choices: ["offer-gets-answer"] }, reply_ts: "1761400000.0001009", updated_at: "2026-10-26T10:00:00Z" }],
    messages: [msg("1761500001.000100", "#9999999 nadie contesta")],
  });
  await runIntake({ slack: f.slack, garden: f.garden, now, log: () => {} });
  assert.deepEqual(f.posted.map((p) => p.text), [PASS_TO_OWNER, "Okay, I'm on it. Which order is this? Send the number, like #1234567."]);
  assert.deepEqual(f.state.items.map((i) => i.state), ["passed", "asked"]);
});

test("thread replies and bot posts are not new ops messages", () => {
  assert.equal(isOpsMessage(msg("2.0", "x", { thread_ts: "1.0" }), "UBOT"), false);
  assert.equal(isOpsMessage(msg("2.0", "x", { thread_ts: "2.0" }), "UBOT"), true);
  assert.equal(isOpsMessage(msg("2.0", "x", { bot_id: "B1" }), "UBOT"), false);
});
