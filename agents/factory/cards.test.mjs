// node --test agents/factory/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAgents } from "../thinking/parse.mjs";
import {
  assertGardenUrl, conversationSignals, stuckOrderSignals, photoSignals, gardenScoreSignals,
  LIFECYCLE_OWNER, EXAMPLES_PER_CARD, ideaCards, clusterCards, factoryCards, runFailureKind,
  errorCards, errorKey, ERROR_CARDS_PER_DAY,
} from "./cards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agents = loadAgents(join(here, "../thinking"));
const nicks = Object.fromEntries(agents.map((a) => [a.id, a.nick]));
const NOW = new Date("2026-10-13T12:00:00Z");
const FUTURE = "2026-10-14T12:00:00Z";
const PAST = "2026-10-12T12:00:00Z";
const criteria = { activeOrderTags: ["QA-AUTO"], activeOrderCountries: [], runAllOrders: false };

const order = (o) => ({ id: o.id, order_name: `#${o.id}`, status: "escalated", delivery_at: FUTURE, tags: "QA-AUTO", delivery_address: null, worklist_at: null, escalation_reason: null, ...o });

test("an escalated support thread is Concierge's, a recruiting one Cupid's, labelled as /conversations labels it", () => {
  const signals = conversationSignals([
    { id: "c1", kind: "support", escalation_reason: "no-order", last_inbound_at: PAST },
    { id: "c3", kind: "recruiting", escalation_reason: null, last_inbound_at: PAST },
  ]);
  assert.deepEqual(signals.map((s) => [s.agent, s.key, s.ref.conversation_id]), [["concierge", "no-order", "c1"], ["cupid", "unknown", "c3"]]);
  assert.equal(signals[0].label, "We can't tell which order this is about");
  assert.equal(signals[0].at, PAST);
});

test("stuck orders follow the CX desk rules and the working-set gate", () => {
  const signals = stuckOrderSignals({
    now: NOW,
    criteria,
    orders: [
      order({ id: "pool", escalation_reason: "pool_exhausted" }),
      order({ id: "wave", escalation_reason: "wave_ceiling" }),
      order({ id: "outside", escalation_reason: "pool_exhausted", tags: "other" }),
      order({ id: "stale", escalation_reason: "pool_exhausted", delivery_at: PAST }),
      order({ id: "picked-late", status: "accepted", delivery_at: PAST, tags: null, worklist_at: PAST }),
      order({ id: "cold", status: "reaching_out" }),
      order({ id: "slow", status: "reaching_out" }),
    ],
    liveOffers: [{ order_id: "slow", sla_deadline_at: PAST }],
  });
  const got = signals.map((s) => [s.ref.order_id, s.key, s.agent]).sort();
  assert.deepEqual(got, [
    ["cold", "needs-next-florist", null],
    ["picked-late", "late-delivery", null],
    ["pool", "escalated:pool_exhausted", "scout"],
    ["slow", "offer-stalling", null],
    ["wave", "escalated:wave_ceiling", null],
  ]);
});

test("only photo checks that did not pass are signals; a checker error is its own problem", () => {
  const signals = photoSignals([
    { id: "p1", order_id: "o1", verdict: "pass", providers: [] },
    { id: "p2", order_id: "o2", verdict: "review", providers: [{ provider: "claude", ok: true }] },
    { id: "p3", order_id: "o3", verdict: "review", providers: [{ provider: "gemini", error: "400" }] },
    { id: "p4", order_id: "o4", verdict: "fail", providers: null },
  ]);
  assert.deepEqual(signals.map((s) => s.key), ["review", "provider-error", "fail"]);
});

test("a failed garden score's key is its lifecycle situation, so it lands on a general rule exactly", () => {
  const scenario = (branch_id) => ({ stage_id: "fulfil", branch_id, title: `t-${branch_id}`, expected_outcome: "paid", shopify_order_id: "GARDEN-1" });
  const signals = gardenScoreSignals([
    { scenario_id: "s1", scenario: scenario("deliver-bad-photo"), actual_outcome: "held", scored_at: PAST },
    { scenario_id: "s2", scenario: { ...scenario(null), stage_id: "accept" }, actual_outcome: "stuck", scored_at: PAST },
  ]);
  assert.deepEqual(signals.map((s) => [s.key, s.agent]), [["deliver-bad-photo", "hawkeye"], ["accept", null]]);
});

test("the sweep refuses any Supabase but the garden named by GARDEN_SUPABASE_URL", () => {
  const env = { GARDEN_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
  assert.doesNotThrow(() => assertGardenUrl("https://abcdefghijklmnopqrst.supabase.co", env));
  for (const bad of ["https://zyxwvutsrqponmlkjihg.supabase.co", "https://abcdefghijklmnopqrst.supabase.co.evil.example", "", "not a url"]) {
    assert.throws(() => assertGardenUrl(bad, env), /refusing to run/, bad);
  }
  assert.throws(() => assertGardenUrl("https://abcdefghijklmnopqrst.supabase.co", {}), /GARDEN_SUPABASE_URL is not set/);
  assert.throws(() => assertGardenUrl("https://abcdefghijklmnopqrst.supabase.co", { GARDEN_SUPABASE_URL: "https://example.com" }), /not a Supabase project/);
});

test("every lifecycle id in the owner table exists in /lifecycle and maps to a real agent", () => {
  const lifecycle = readFileSync(join(here, "../../dashboard/lib/lifecycle.ts"), "utf8");
  for (const [id, agent] of Object.entries(LIFECYCLE_OWNER)) {
    assert.ok(lifecycle.includes(`id: "${id}"`), `${id} is not a lifecycle id`);
    assert.ok(agent in nicks, `${agent} has no file in agents/thinking`);
  }
});

test("the schema's allowed agents are exactly the files in agents/thinking, plus factory (the doctor lane)", () => {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  const list = sql.match(/factory_tasks_agent_check check \(agent in \(([^)]*)\)/)[1];
  const allowed = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(allowed, [...agents.map((a) => a.id), "factory"].sort());
});

test("garden_ideas allows exactly the same agents", () => {
  const sql = readFileSync(join(here, "../../supabase/migrations/2026-10-16-garden-decisions.sql"), "utf8");
  const list = sql.match(/garden_ideas_agent_check check \(agent in \(([^)]*)\)/)[1];
  assert.deepEqual([...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort(), agents.map((a) => a.id).sort());
});

const idea = (o) => ({ id: "i1", title: "Ask for the delivery date first", body: "Clients forget it.", agent: "concierge", status: "open", created_by: "staff@example.com", created_at: PAST, updated_at: PAST, ...o });

test("an open idea with an agent becomes one human card for that agent; the rest do not", () => {
  const cards = ideaCards([
    idea(),
    idea({ id: "i2", agent: null }),
    idea({ id: "i3", status: "turned-into-card" }),
    idea({ id: "i4", status: "dropped" }),
    idea({ id: "i5", agent: "nobody" }),
  ], nicks);
  assert.deepEqual(cards.map((c) => [c.fingerprint, c.agent, c.source, c.ideaId]), [["concierge:human:idea-i1", "concierge", "human", "i1"]]);
  assert.equal(cards[0].title, "Concierge: Ask for the delivery date first");
  assert.equal(cards[0].summary, "the owner's idea: Clients forget it.");
});

test("the same idea always gives the same fingerprint, so a rerun refreshes its one card", () => {
  const a = ideaCards([idea()], nicks)[0].fingerprint;
  const b = ideaCards([idea({ title: "edited", body: "" })], nicks)[0].fingerprint;
  assert.equal(a, b);
  assert.notEqual(a, ideaCards([idea({ agent: "cupid" })], nicks)[0].fingerprint, "a different agent is a different card");
});

// Cases for one cluster: `perDay` cases on each of `days` Madrid days ending
// 2026-10-14, at noon UTC (afternoon in Madrid, so the day never shifts).
const TODAY = "2026-10-14";
const dayOf = (back) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
function gapsOver(days, perDay, data, prefix) {
  const out = [];
  for (let d = 0; d < days; d++) for (let i = 0; i < perDay; i++) {
    out.push({ case_id: `order:${prefix}${d}-${i}`, seq: 3, type: "rule_gap", data: { ...data, gap: `No rule for ${prefix} case ${d}-${i}` }, created_at: `${dayOf(d)}T12:${String(i % 60).padStart(2, "0")}:00Z` });
  }
  return out;
}
const totals = (n) => new Map(Array.from({ length: 7 }, (_, d) => [dayOf(d), n]));
const REFUND = { agent: "concierge", step: "refund" };

test("a cluster that recurs on 5 days with more than 20 cases each, well above the noise floor, becomes one card", () => {
  const events = [
    ...gapsOver(5, 21, REFUND, "r"),
    ...gapsOver(5, 21, { step: "refund" }, "u").map((e) => ({ ...e, data: { ...e.data, agent: "nobody" } })),
  ];
  const cards = clusterCards(events, nicks, totals(200), { today: TODAY });
  assert.deepEqual(cards.map((c) => [c.fingerprint, c.source, c.evidence.count, c.evidence.occasions.length]), [
    ["concierge:cluster:refund", "cluster", 105, 5],
  ]);
  assert.equal(cards[0].title, "Concierge: no rule for cases held at refund");
  assert.match(cards[0].summary, /^105 cases were held at refund for want of a rule, on 5 days well above the noise floor\. The newest gap: /);
  assert.equal(cards[0].evidence.examples.length, EXAMPLES_PER_CARD);
});

test("no card: too few occasions, too few cases per day, or a rate randomness explains", () => {
  assert.deepEqual(clusterCards(gapsOver(4, 30, REFUND, "a"), nicks, totals(200), { today: TODAY }), [], "4 occasions");
  assert.deepEqual(clusterCards(gapsOver(7, 20, REFUND, "b"), nicks, totals(200), { today: TODAY }), [], "20 is not more than 20");
  assert.deepEqual(clusterCards(gapsOver(7, 25, REFUND, "c"), nicks, totals(1000), { today: TODAY }), [], "2.5% of the day's cases is noise");
  assert.deepEqual(clusterCards(gapsOver(7, 25, REFUND, "d"), nicks, new Map(), { today: TODAY }), [], "no denominator, no evidence");
  assert.deepEqual(clusterCards(gapsOver(20, 25, REFUND, "e").filter((e) => e.created_at < dayOf(7)), nicks, totals(200), { today: TODAY }), [], "outside the window");
});

test("cluster and human are allowed sources in the schema", () => {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  const check = sql.match(/factory_tasks_source_check\s+check \(source in \(([^)]*)\)\)/)[1];
  for (const s of ["human", "cluster"]) assert.ok(check.includes(`'${s}'`), `${s} missing from the source check`);
});

// ---- Doctor lane: the factory's own failed runs ---------------------------------
const H = 3600_000;
const SWEEP_NOW = Date.parse("2026-10-22T12:00:00Z");
const failedRun = (id, hoursAgo, notes, source = "photo_review") => ({
  id, task_id: `t-${id}`, outcome: "failed", finished_at: new Date(SWEEP_NOW - hoursAgo * H).toISOString(), notes, task: { source },
});

test("failure kinds come from the run notes the executor writes", () => {
  assert.deepEqual(runFailureKind("Stopped at the time cap before finishing."), { kind: "time-cap", outage: null });
  assert.equal(runFailureKind("The agent ended without a valid report.md.").kind, "no-report");
  assert.equal(runFailureKind("The box exited with code 1 and no valid report.").kind, "box-exit");
  assert.equal(runFailureKind("Executor error: git push exited 1").kind, "executor-error");
  assert.equal(runFailureKind("The agent step never finished (cancelled or crashed). The box exited with code -1 and no valid report.").kind, "agent-step-crashed");
  assert.equal(runFailureKind("Never finished: the executor died with its host.").kind, "never-finished");
  assert.equal(runFailureKind("Committed a video, which never goes into git: a.webm").kind, "video-committed");
  assert.equal(runFailureKind("something new").kind, "other");
});

test("an expired or invalid Claude login, a rate limit and an Anthropic 5xx are outages, not code bugs", () => {
  const tail = (t) => `The box exited with code 1 and no valid report. Last output: ${t}`;
  assert.equal(runFailureKind(tail('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}')).outage, "claude-login");
  assert.equal(runFailureKind(tail("Invalid API key · Please run /login")).outage, "claude-login");
  assert.equal(runFailureKind(tail('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')).outage, "rate-limit");
  assert.equal(runFailureKind(tail("Claude usage limit reached. Your limit will reset at 5pm.")).outage, "rate-limit");
  assert.equal(runFailureKind(tail('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}')).outage, "anthropic-5xx");
  assert.equal(runFailureKind(tail("API Error: 500 Internal server error")).outage, "anthropic-5xx");
  assert.equal(runFailureKind(tail("TypeError: cannot read x of undefined")).outage, null);
});

test("two failed runs of the same kind in 24h make ONE factory card; outages make none and are listed", () => {
  const runs = [
    failedRun("a", 1, "Stopped at the time cap before finishing."),
    failedRun("b", 20, "Stopped at the time cap before finishing."),
    failedRun("c", 3, "Stopped at the time cap before finishing."),
    failedRun("old", 30, "The agent ended without a valid report.md."),
    failedRun("d", 2, "The agent ended without a valid report.md."),
    failedRun("e", 1, "The box exited with code 1 and no valid report. Last output: API Error: 401 OAuth token has expired"),
    failedRun("f", 2, "The box exited with code 1 and no valid report. Last output: API Error: 401 OAuth token has expired"),
    { ...failedRun("ok", 1, "fine"), outcome: "fixed" },
  ];
  const { cards, outages } = factoryCards(runs, { now: SWEEP_NOW });
  assert.deepEqual(cards.map((c) => [c.fingerprint, c.agent, c.source, c.evidence.count]), [["factory:factory:time-cap", "factory", "factory", 3]]);
  assert.match(cards[0].title, /^Factory: /);
  assert.equal(cards[0].evidence.examples[0].run_id, "a", "newest first");
  assert.deepEqual(outages.map((o) => [o.run_id, o.outage]), [["e", "claude-login"], ["f", "claude-login"]]);
});

test("the doctor's own failed runs and parked problems make no new card", () => {
  const cap = "Stopped at the time cap before finishing.";
  const doctorRuns = [failedRun("a", 1, cap, "factory"), failedRun("b", 2, cap, "factory")];
  assert.deepEqual(factoryCards(doctorRuns, { now: SWEEP_NOW }).cards, []);
  const runs = [failedRun("a", 1, cap), failedRun("b", 2, cap)];
  assert.deepEqual(factoryCards(runs, { now: SWEEP_NOW, parked: ["factory:factory:time-cap"] }).cards, []);
});

test("factory is an allowed source in the schema, and parked an allowed status", () => {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  assert.match(sql.match(/factory_tasks_source_check\s+check \(source in \(([^)]*)\)\)/)[1], /'factory'/);
  assert.match(sql.match(/factory_tasks_status_check\s+check \(status in \(([^)]*)\)\)/)[1], /'parked'/);
});


// ---- errors from PostHog (fixtures/posthog-errors.json) ----
const ERR_NOW = Date.parse("2026-10-22T12:00:00Z");
const errorEvents = JSON.parse(readFileSync(join(here, "fixtures/posthog-errors.json"), "utf8"));

test("PostHog errors group by context and first line, ids and numbers ignored; one-offs, old events and other events make no card", () => {
  const { cards, held } = errorCards(errorEvents, { now: ERR_NOW });
  assert.deepEqual(cards.map((c) => [c.evidence.problem, c.evidence.line, c.evidence.count]), [
    ["webhook.orders_create", "insert orders failed: duplicate key #", 3],
    ["cron.waves_tick", "rpc next_wave failed", 2],
    ["match.auto", "nobody in range (ingest: found-nothing)", 2],
  ]);
  assert.deepEqual(held, [{ context: "workflow.match-and-write", line: "timeout after #ms for order #", count: 2 }]);
  for (const c of cards) {
    assert.equal(c.source, "error");
    assert.equal(c.agent, "factory");
    assert.match(c.fingerprint, /^factory:error:/);
  }
  assert.equal(cards[0].latest_signal_at, "2026-10-22T11:00:00Z");
  assert.equal(errorKey(errorEvents[4]).context, "workflow.match-and-write");
});

test("at most 3 new error cards a day, but a live card is always refreshed", () => {
  const first = errorCards(errorEvents, { now: ERR_NOW }).cards;
  assert.equal(first.length, ERROR_CARDS_PER_DAY);
  const later = errorCards(errorEvents, { now: ERR_NOW, openedToday: 3, live: [first[1].fingerprint] }).cards;
  assert.deepEqual(later.map((c) => c.fingerprint), [first[1].fingerprint]);
  assert.equal(errorCards(errorEvents, { now: ERR_NOW, openedToday: 2 }).cards.length, 1);
});

test("error is an allowed source in the schema", () => {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  assert.match(sql.match(/factory_tasks_source_check\s+check \(source in \(([^)]*)\)\)/)[1], /'error'/);
});
