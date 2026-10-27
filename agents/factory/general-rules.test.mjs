// node --test agents/factory/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PHASES, CROSS_CUTTING } from "../../dashboard/lib/lifecycle.ts";
import { loadAgents } from "../thinking/parse.mjs";
import {
  RULES, CARD_LIFE, NEAR_MATCH, MANAGERS, DAY_MS, checkRules, alertId, placeAlerts, readNearAnswer, nearMatchRequest,
  ruleCardPlan, quietCards, quietDaysLeft,
} from "./general-rules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const branches = [...PHASES.flatMap((p) => p.stages.flatMap((s) => s.branches ?? [])), ...CROSS_CUTTING];
const NOW = Date.parse("2026-10-27T12:00:00Z");
const ago = (days) => new Date(NOW - days * DAY_MS).toISOString();

test("the owner's numbers: 3 alerts in 7 days open a card, 7 quiet days close it; Haiku 4.5 capped at $0.50 a day", () => {
  assert.deepEqual({ ...CARD_LIFE }, { openAlerts: 3, openWindowDays: 7, quietDays: 7 });
  assert.equal(NEAR_MATCH.model, "anthropic/claude-haiku-4.5");
  assert.equal(NEAR_MATCH.dailyCapUsd, 0.5);
});

test("the 13 general rules cover every lifecycle situation exactly once, each owned by a manager as the design says", () => {
  assert.equal(RULES.length, 13);
  assert.deepEqual(checkRules(RULES, branches), []);
  const owned = (m) => RULES.filter((r) => r.owner === m).map((r) => r.id).sort();
  assert.deepEqual(owned("harvey"), ["area-has-florists", "offer-reaches-shop", "only-ready-shops", "recruiting-honest-once"]);
  assert.deepEqual(owned("louis"), ["photo-proves-delivery"]);
  assert.deepEqual(owned("jessica"), ["pay-exactly-owed"]);
  assert.equal(owned("donna").length, 7);
  const thinking = new Set(loadAgents(join(here, "../thinking")).map((a) => a.id));
  for (const r of RULES) if (r.agent) assert.ok(thinking.has(r.agent), `${r.id}: ${r.agent} has no thinking file`);
  for (const m of Object.values(MANAGERS)) if (m.promotedFrom) assert.ok(thinking.has(m.promotedFrom));
});

test("checkRules catches a missing, unknown or doubled situation, a bad owner, and an added situation without its fields", () => {
  const rules = [{ id: "a", owner: "donna", members: ["s1", "s2"] }, { id: "b", owner: "mike", members: ["s2", "ghost"] }];
  const bs = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4", addedBy: "harvey", addedOn: "2026-10-27", fromNear: "a" }];
  const problems = checkRules(rules, bs);
  for (const want of ["s3 sits under no general rule", "ghost is not a situation", "s2 sits under two", "b has no manager", "s4 sits under no general rule", "s4: fromNear \"a\""]) {
    assert.ok(problems.some((p) => p.includes(want)), `missing: ${want}\n${problems.join("\n")}`);
  }
  const good = checkRules([{ id: "a", owner: "donna", members: ["s1", "s4"] }], [{ id: "s1" }, { id: "s4", addedBy: "donna", addedOn: "2026-10-27", fromNear: "a" }]);
  assert.deepEqual(good, []);
  const half = checkRules([{ id: "a", owner: "donna", members: ["s4"] }], [{ id: "s4", addedBy: "donna" }]);
  assert.ok(half.some((p) => p.includes("addedOn")));
});

// ---- placing alerts ----
const sig = (source, key, ref, label = `label ${key}`) => ({ source, key, label, ref, at: null });

test("an alert whose key is a situation id lands on its rule for free; the same thing seen again is the same alert", async () => {
  let calls = 0;
  const ask = async () => { calls++; return { args: { rule: "order-in-clean", distance: "near", why: "x" }, costUsd: 0.001 }; };
  const a = sig("garden_score", "deliver-bad-photo", { scenario_id: "s1", order_id: "o1" });
  const { placed, spentUsd } = await placeAlerts([a], { ask });
  assert.equal(calls, 0);
  assert.equal(spentUsd, 0);
  assert.deepEqual([placed[0].rule_id, placed[0].match], ["photo-proves-delivery", "exact"]);
  assert.equal(alertId(a), alertId({ ...a, at: "later" }));
  assert.notEqual(alertId(a), alertId(sig("garden_score", "deliver-bad-photo", { scenario_id: "s2" })));
});

test("no exact match: the fake model's near answer counts toward a rule, a far one or an invented rule counts nowhere", async () => {
  const answers = { "turn_cap": { rule: "florist-questions-answered", distance: "near" }, "intent": { rule: "recruiting-honest-once", distance: "far" }, "odd": { rule: "made-up", distance: "near" } };
  const seen = [];
  const ask = async (req) => {
    seen.push(req);
    const key = req.messages[1].content.match(/key "([^"]+)"/)[1];
    return { args: { ...answers[key], why: "because" }, costUsd: 0.002 };
  };
  const { placed, spentUsd } = await placeAlerts([
    sig("conversation_escalation", "turn_cap", { conversation_id: "c1" }),
    sig("conversation_escalation", "intent", { conversation_id: "c2" }),
    sig("conversation_escalation", "odd", { conversation_id: "c3" }),
  ], { ask });
  assert.deepEqual(placed.map((p) => [p.rule_id, p.match]), [["florist-questions-answered", "near"], [null, "none"], [null, "none"]]);
  assert.equal(spentUsd, 0.006);
  assert.equal(seen[0].model, "anthropic/claude-haiku-4.5");
  assert.equal(seen[0].tool_choice.function.name, "place_alert");
  assert.ok(!seen[0].messages[1].content.includes("c1"), "ids stay out of the story");
});

test("past the daily cap, or when the model fails, alerts wait for a later sweep; without a key nothing is guessed", async () => {
  let calls = 0;
  const ask = async () => { calls++; return { args: { rule: "order-on-map", distance: "near" }, costUsd: 0.01 }; };
  const alerts = [1, 2, 3].map((i) => sig("stuck_order", `k${i}`, { order_id: `o${i}` }));
  const capped = await placeAlerts(alerts, { ask, spentUsd: NEAR_MATCH.dailyCapUsd - 0.015 });
  assert.equal(calls, 1);
  assert.equal(capped.placed.length, 1);
  assert.equal(capped.waiting.length, 2);
  assert.match(capped.waiting[0].why, /cap/);
  const broken = await placeAlerts(alerts.slice(0, 1), { ask: async () => { throw new Error("502"); } });
  assert.deepEqual([broken.placed.length, broken.waiting.length], [0, 1]);
  const off = await placeAlerts(alerts.slice(0, 1), { ask: null });
  assert.match(off.waiting[0].why, /off/);
});

test("alerts with the same story share one model call within a sweep", async () => {
  let calls = 0;
  const ask = async () => { calls++; return { args: { rule: "offer-gets-answer", distance: "near" }, costUsd: 0.002 }; };
  const { placed } = await placeAlerts([1, 2, 3].map((i) => sig("stuck_order", "offer-stalling", { order_id: `o${i}` })), { ask });
  assert.equal(calls, 1);
  assert.deepEqual(placed.map((p) => p.rule_id), ["offer-gets-answer", "offer-gets-answer", "offer-gets-answer"]);
  assert.equal(new Set(placed.map((p) => p.alert_id)).size, 3);
});

test("readNearAnswer and the request agree on the rule list", () => {
  const req = nearMatchRequest(sig("photo_review", "fail", { photo_verification_id: "p1", confidence: 0.4 }));
  assert.deepEqual(req.tools[0].function.parameters.properties.rule.enum, RULES.map((r) => r.id));
  assert.equal(readNearAnswer(undefined).match, "none");
});

// ---- a card's life ----
const placed = (rule, days, extra = {}) => ({ alert_id: `a${Math.random()}`, rule_id: rule, match: "exact", key: "k", label: "l", source: "garden_score", placed_at: ago(days), ref: {}, ...extra });

test("a rule opens its card at 3 alerts in 7 days, not at 2, and older alerts do not count", () => {
  const two = [placed("order-on-map", 1), placed("order-on-map", 2), placed("order-on-map", 8)];
  assert.deepEqual(ruleCardPlan({ alerts: two, cards: [], now: NOW }), []);
  const three = [...two, placed("order-on-map", 6.9)];
  const [p] = ruleCardPlan({ alerts: three, cards: [], now: NOW });
  assert.equal(p.action, "open");
  assert.equal(p.card.fingerprint, "rule:order-on-map");
  assert.equal(p.card.source, "rule");
  assert.equal(p.card.manager, "donna");
  assert.equal(p.card.agent, "concierge");
  assert.equal(p.card.title, "Donna: Every order has the right place on the map.");
  assert.equal(p.card.evidence.count, 3);
  assert.equal(p.card.last_seen_at, ago(1));
});

test("near matches count toward the rule; alerts placed nowhere never open anything", () => {
  const alerts = [placed("offer-gets-answer", 1, { match: "near" }), placed("offer-gets-answer", 2), placed("offer-gets-answer", 3, { match: "near" }), placed(null, 1, { match: "none" })];
  const plan = ruleCardPlan({ alerts, cards: [], now: NOW });
  assert.deepEqual(plan.map((p) => [p.action, p.card.general_rule, p.card.evidence.near]), [["open", "offer-gets-answer", 2]]);
});

test("Jessica's money card opens for a person: agent factory, manager jessica", () => {
  const alerts = [1, 2, 3].map((d) => placed("pay-exactly-owed", d));
  const [p] = ruleCardPlan({ alerts, cards: [], now: NOW });
  assert.deepEqual([p.card.manager, p.card.agent], ["jessica", "factory"]);
});

test("a live card is refreshed; a closed card reopens on one new alert, the same card; dropped and parked are left alone", () => {
  const alerts = [placed("order-on-map", 1)];
  const card = (status, extra = {}) => [{ id: "card-1", general_rule: "order-on-map", status, ...extra }];
  assert.deepEqual(ruleCardPlan({ alerts, cards: card("in-progress"), now: NOW }).map((p) => [p.action, p.id]), [["refresh", "card-1"]]);
  assert.deepEqual(ruleCardPlan({ alerts, cards: card("done", { closed_at: ago(2), reopened_count: 1 }), now: NOW }).map((p) => [p.action, p.id, p.reopened_count]), [["reopen", "card-1", 2]]);
  assert.deepEqual(ruleCardPlan({ alerts, cards: card("done", { closed_at: ago(0.5) }), now: NOW }), [], "an alert from before the close does not reopen");
  assert.deepEqual(ruleCardPlan({ alerts, cards: card("dropped"), now: NOW }), []);
  assert.deepEqual(ruleCardPlan({ alerts, cards: card("parked"), now: NOW }), []);
});

test("a card closes only after 7 quiet days counted from the later of the merge and the last alert", () => {
  const live = [
    { id: "quiet", status: "in-progress", merged_at: ago(8), last_seen_at: ago(9), runs: [{ finished_at: ago(9) }] },
    { id: "alert-after-merge", status: "in-progress", merged_at: ago(8), last_seen_at: ago(6), runs: [] },
    { id: "merged-recently", status: "in-progress", merged_at: ago(6.9), last_seen_at: ago(20), runs: [] },
    { id: "never-merged", status: "open", merged_at: null, last_seen_at: ago(30), runs: [] },
    { id: "running", status: "in-progress", merged_at: ago(10), last_seen_at: ago(10), runs: [{ finished_at: null }] },
    { id: "idea", source: "human", status: "in-progress", merged_at: ago(7), last_seen_at: null, runs: [] },
    { id: "parked", status: "parked", merged_at: ago(10), last_seen_at: ago(10), runs: [] },
  ];
  assert.deepEqual(quietCards(live, NOW), ["quiet", "idea"]);
  assert.equal(quietDaysLeft(live[1], NOW), 1);
  assert.equal(quietDaysLeft(live[3], NOW), null);
});

test("a problem still there keeps its rule's card from closing: the card's last sighting is the alert's, not its first", () => {
  // One stuck order, first seen 10 days ago and still stuck at the last sweep.
  const still = placed("order-on-map", 10, { last_seen_at: ago(0.1) });
  const [p] = ruleCardPlan({ alerts: [still], cards: [{ id: "card-1", general_rule: "order-on-map", status: "in-progress" }], now: NOW });
  assert.equal(p.action, "refresh");
  assert.equal(p.card.last_seen_at, ago(0.1));
  const live = [{ id: "card-1", status: "in-progress", merged_at: ago(8), last_seen_at: p.card.last_seen_at, runs: [] }];
  assert.deepEqual(quietCards(live, NOW), [], "the rule is not quiet while its alert is still seen");
  // Closed, then the same alert is seen again: the same card reopens.
  const done = [{ id: "card-1", general_rule: "order-on-map", status: "done", closed_at: ago(1) }];
  assert.deepEqual(ruleCardPlan({ alerts: [still], cards: done, now: NOW }).map((x) => [x.action, x.id]), [["reopen", "card-1"]]);
  // Opening still counts alerts placed in the window, not old ones still seen.
  const old = [1, 2, 3].map((i) => placed("order-on-map", 10 + i, { last_seen_at: ago(0.1) }));
  assert.deepEqual(ruleCardPlan({ alerts: old, cards: [], now: NOW }), []);
});

test("the cap holds: the reserve grows to the dearest call seen, and a failed call still counts what it cost", async () => {
  let calls = 0;
  const dear = async () => { calls++; return { args: { rule: "order-on-map", distance: "near" }, costUsd: 0.05 }; };
  const alerts = [1, 2, 3].map((i) => sig("stuck_order", `d${i}`, { order_id: `o${i}` }));
  const out = await placeAlerts(alerts, { ask: dear, spentUsd: 0.42 });
  assert.equal(calls, 1, "a second $0.05 call would end at $0.52");
  assert.ok(out.spentUsd <= NEAR_MATCH.dailyCapUsd);
  calls = 0;
  const failing = async () => { calls++; const e = new Error("no tool call"); e.costUsd = 0.2; throw e; };
  const f = await placeAlerts(alerts, { ask: failing, spentUsd: 0 });
  assert.equal(calls, 2, "$0.20 + $0.20 fit, a third would end at $0.60");
  assert.ok(Math.abs(f.spentUsd - 0.4) < 1e-9);
  assert.equal(f.waiting.length, 3);
  // Every call, answered or failed, is in the ledger the sweep keeps per day.
  assert.deepEqual(f.calls.map((c) => [c.alert_id, c.ok, c.cost_usd]), [[alertId(alerts[0]), false, 0.2], [alertId(alerts[1]), false, 0.2]]);
  assert.deepEqual(out.calls.map((c) => [c.ok, c.cost_usd]), [[true, 0.05]]);
  const unknownCost = await placeAlerts(alerts.slice(0, 1), { ask: async () => { throw new Error("timeout"); } });
  assert.equal(unknownCost.spentUsd, NEAR_MATCH.reserveUsd, "a failed call of unknown cost counts the reserve");
});

test("the migration adds the rule source, the card-life columns and the alert table", () => {
  const sql = readFileSync(join(here, "../supabase/migrations/20261027120000_factory_rule_cards.sql"), "utf8");
  assert.match(sql.match(/factory_tasks_source_check\s+check \(source in \(([^)]*)\)\)/)[1], /'rule'/);
  for (const col of ["general_rule", "manager", "merged_at", "closed_at", "reopened_at", "reopened_count"]) assert.match(sql, new RegExp(`add column if not exists ${col}\\b`));
  assert.match(sql, /create table if not exists factory_alerts/);
  assert.match(sql, /alter table factory_alerts add column if not exists last_seen_at timestamptz/);
  assert.match(sql, /create table if not exists factory_near_calls/);
  for (const m of Object.keys(MANAGERS)) assert.match(sql, new RegExp(`'${m}'`));
});
