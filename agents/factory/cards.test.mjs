// node --test agents/factory/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAgents } from "../thinking/parse.mjs";
import {
  assertGardenUrl, buildCards, conversationSignals, stuckOrderSignals, photoSignals, gardenScoreSignals,
  LIFECYCLE_OWNER, EXAMPLES_PER_CARD,
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
  const { cards } = buildCards(conversationSignals([
    { id: "c1", kind: "support", escalation_reason: "no-order", last_inbound_at: PAST },
    { id: "c2", kind: "support", escalation_reason: "no-order", last_inbound_at: FUTURE },
    { id: "c3", kind: "recruiting", escalation_reason: "intent", last_inbound_at: PAST },
  ]), nicks);
  assert.deepEqual(cards.map((c) => [c.fingerprint, c.evidence.count]), [
    ["concierge:conversation_escalation:no-order", 2],
    ["cupid:conversation_escalation:intent", 1],
  ]);
  assert.equal(cards[0].title, "Concierge: We can't tell which order this is about");
  assert.equal(cards[0].latest_signal_at, FUTURE);
  assert.equal(cards[0].evidence.examples[0].conversation_id, "c2");
});

test("the same signals always give the same fingerprints, so a rerun refreshes rather than duplicates", () => {
  const rows = [{ id: "c1", kind: "support", escalation_reason: "turn_cap" }, { id: "c2", kind: "recruiting", escalation_reason: null }];
  const a = buildCards(conversationSignals(rows), nicks).cards.map((c) => c.fingerprint);
  const b = buildCards(conversationSignals([...rows].reverse()), nicks).cards.map((c) => c.fingerprint);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 2);
  assert.ok(a.includes("cupid:conversation_escalation:unknown"));
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
  const { cards, unowned } = buildCards(signals, nicks);
  assert.deepEqual(cards.map((c) => c.fingerprint), ["scout:stuck_order:escalated:pool_exhausted"]);
  assert.equal(cards[0].title, "Scout: No florist left in range — escalated");
  assert.equal(unowned.reduce((n, u) => n + u.count, 0), 4);
});

test("only photo checks that did not pass become Hawkeye cards; a checker error is its own problem", () => {
  const { cards } = buildCards(photoSignals([
    { id: "p1", order_id: "o1", verdict: "pass", providers: [] },
    { id: "p2", order_id: "o2", verdict: "review", providers: [{ provider: "claude", ok: true }] },
    { id: "p3", order_id: "o3", verdict: "review", providers: [{ provider: "gemini", error: "400" }] },
    { id: "p4", order_id: "o4", verdict: "fail", providers: null },
  ]), nicks);
  assert.deepEqual(cards.map((c) => c.fingerprint).sort(), [
    "hawkeye:photo_review:fail",
    "hawkeye:photo_review:provider-error",
    "hawkeye:photo_review:review",
  ]);
});

test("a failed garden score goes to the agent owning its lifecycle branch, else nowhere", () => {
  const scenario = (branch_id) => ({ stage_id: "fulfil", branch_id, title: `t-${branch_id}`, expected_outcome: "paid", shopify_order_id: "GARDEN-1" });
  const { cards, unowned } = buildCards(gardenScoreSignals([
    { scenario_id: "s1", scenario: scenario("deliver-bad-photo"), actual_outcome: "held", scored_at: PAST },
    { scenario_id: "s2", scenario: scenario("accept-race"), actual_outcome: "stuck", scored_at: PAST },
  ]), nicks);
  assert.deepEqual(cards.map((c) => c.fingerprint), ["hawkeye:garden_score:deliver-bad-photo"]);
  assert.deepEqual(unowned.map((u) => u.key), ["accept-race"]);
});

test("a card keeps at most a handful of examples but counts all of them", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, kind: "support", escalation_reason: "turn_cap" }));
  const [card] = buildCards(conversationSignals(rows), nicks).cards;
  assert.equal(card.evidence.count, 12);
  assert.equal(card.evidence.examples.length, EXAMPLES_PER_CARD);
});

test("a signal mapped to an agent with no file is refused", () => {
  assert.throws(() => buildCards([{ source: "photo_review", agent: "ghost", key: "x", label: "x", ref: {}, at: null }], nicks), /unknown agent "ghost"/);
});

test("the sweep refuses any Supabase but the garden", () => {
  assert.doesNotThrow(() => assertGardenUrl("https://your-project-ref.supabase.co"));
  for (const bad of ["https://abcdefghijklmnopqrst.supabase.co", "https://your-project-ref.supabase.co.evil.example", "", "not a url"]) {
    assert.throws(() => assertGardenUrl(bad), /refusing to run/, bad);
  }
});

test("every lifecycle id in the owner table exists in /lifecycle and maps to a real agent", () => {
  const lifecycle = readFileSync(join(here, "../../dashboard/lib/lifecycle.ts"), "utf8");
  for (const [id, agent] of Object.entries(LIFECYCLE_OWNER)) {
    assert.ok(lifecycle.includes(`id: "${id}"`), `${id} is not a lifecycle id`);
    assert.ok(agent in nicks, `${agent} has no file in agents/thinking`);
  }
});

test("the schema's allowed agents are exactly the files in agents/thinking", () => {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  const list = sql.match(/factory_tasks_agent_check check \(agent in \(([^)]*)\)/)[1];
  const allowed = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(allowed, agents.map((a) => a.id).sort());
});
