// node --test agents/monitoring/monitoring.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAgents } from "../thinking/parse.mjs";
import { agentsBelowMinimum } from "../factory/thresholds.mjs";
import { minimumRows, THINKING_DIR } from "./minimums.mjs";
import { traceRow, polyglotReplay, readTranslationPrompt, toneRows } from "./external-rows.mjs";
import { deepAnalysisCards, madridDay, parseContextRef, trimContext, FAILING_PER_MEASURE } from "./deep-analysis.mjs";
import { buildTranslationPrompt } from "../../dashboard/lib/messages/translate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agents = loadAgents(THINKING_DIR);
const schema = readFileSync(join(here, "schema.sql"), "utf8");

test("agent_minimums holds every measure in the agent files, with the minimum as written", () => {
  const rows = minimumRows(agents);
  assert.equal(rows.length, agents.reduce((n, a) => n + a.good.length, 0));
  const hawkeye = rows.find((r) => r.agent === "hawkeye" && r.measure === "planted-good-photo-passed");
  assert.deepEqual(
    [hawkeye.op, hawkeye.minimum, hawkeye.percent, hawkeye.window_days, hawkeye.min_cases, hawkeye.kind],
    [">=", 0.9, true, 2, 10, "decides"],
  );
  const tone = rows.find((r) => r.agent === "concierge" && r.measure === "tone");
  assert.deepEqual([tone.minimum, tone.percent, tone.kind], [0.7, false, "advice"]);
});

test("the registry the dashboard ships carries the same minimums the table is written from", () => {
  const generated = readFileSync(join(here, "../../dashboard/lib/agents/registry.generated.ts"), "utf8");
  for (const a of agents) for (const m of a.good) {
    assert.ok(generated.includes(`"id": "${m.id}"`), `${a.id}/${m.id} missing from registry.generated.ts; run node agents/thinking/build.mjs`);
    assert.ok(generated.includes(JSON.stringify(m.minimum.text)), `${a.id}/${m.id} minimum differs from registry.generated.ts`);
  }
});

test("every measure measurable now is computed in schema.sql, and none that is not yet", () => {
  for (const a of agents) for (const m of a.good) {
    const computed = schema.includes(`'${m.id}'`);
    assert.equal(computed, m.measurableNow, `${a.id}/${m.id}: measurable now=${m.measurableNow} but schema.sql ${computed ? "computes" : "does not compute"} it`);
  }
});

const babelObs = {
  traceId: "t1", name: "babel.run", startTime: "2026-10-14T06:27:23.389Z", level: "DEFAULT", sessionId: "order-1",
  input: "Translate these…", output: "{\"a\": \"b\"}", metadata: { agent_id: "babel", strings: 3 },
};

test("a Langfuse run becomes a row whose prompt hash matches the md5 Postgres takes of ai_context.prompt", () => {
  const row = traceRow(babelObs);
  assert.equal(row.agent, "babel");
  assert.equal(row.input_md5, createHash("md5").update("Translate these…", "utf8").digest("hex"));
  assert.equal(row.session_id, "order-1");
  assert.equal(row.replay, null);
  assert.equal(traceRow({ ...babelObs, sessionId: "", output: "x".repeat(5000) }).output.length, 2000);
  assert.equal(traceRow({ ...babelObs, sessionId: "" }).session_id, null);
});

test("Polyglot's traced reply is judged again with the route's own check", () => {
  const prompt = buildTranslationPrompt("sms.offer", "Order {order} is ready", ["fr", "es"]);
  assert.deepEqual(readTranslationPrompt(prompt), { source: "Order {order} is ready", targets: ["fr", "es"] });

  const good = polyglotReplay(prompt, '{"fr": "Commande {order} prete", "es": "Pedido {order} listo"}', "sms.offer");
  assert.deepEqual(good.map((v) => [v.locale, v.ok]), [["fr", true], ["es", true]]);

  const lost = polyglotReplay(prompt, '```json\n{"fr": "Commande prête"}\n```', "sms.offer");
  assert.deepEqual(lost.map((v) => [v.locale, v.ok]), [["fr", false], ["es", false]]);
  assert.ok(lost[0].reasons.some((r) => r.includes("{order}")));
  assert.ok(lost[0].reasons.some((r) => r.includes("GSM-7")));
  assert.deepEqual(lost[1].reasons, ["no translation in the reply"]);

  assert.equal(polyglotReplay("Translate into Spanish: hi", '{"es": "hola"}', "sms.offer"), null, "a prompt of another shape is not judged");
  assert.equal(polyglotReplay(prompt, "{}", undefined), null, "no key, no verdict");
});

test("a tone score the check could not give is left out, not stored as zero", () => {
  const rows = toneRows({ model: "haiku", results: [{ id: "m1", score: 0.8, reason: "warm" }, { id: "m2", score: null, reason: "not scored" }] });
  assert.deepEqual(rows, [{ message_id: "m1", score: 0.8, reason: "warm", model: "haiku" }]);
  assert.deepEqual(toneRows({ skipped: "no key" }), []);
});

const TODAY = "2026-10-14";
const YESTERDAY = "2026-10-13";
const caseRow = (i, passed, day = TODAY) => ({
  agent: "hawkeye", measure: "planted-good-photo-passed", case_ref: `photo_verifications:p${i}`,
  at: `${day}T${String(i % 24).padStart(2, "0")}:00:00.000Z`, day, passed,
  summary: `case ${i}`, link: `https://garden/orders/o${i}`, trace_link: null,
  context_ref: `photo_verifications.ai_context id=p${i}`,
});

function hawkeyeBelow() {
  const rows = [
    { agent: "hawkeye", measure: "planted-good-photo-passed", day: YESTERDAY, cases: 12, matching: 6 },
    { agent: "hawkeye", measure: "planted-good-photo-passed", day: TODAY, cases: 12, matching: 6 },
  ];
  return agentsBelowMinimum(agents, rows, TODAY);
}

test("an agent below a minimum two days running gets one deep-analysis card with its failing cases and a control", () => {
  const cases = [
    ...Array.from({ length: 30 }, (_, i) => caseRow(i, false, i < 15 ? YESTERDAY : TODAY)),
    caseRow(40, true, YESTERDAY),
    caseRow(23, true, TODAY),
  ];
  const [card, ...rest] = deepAnalysisCards(hawkeyeBelow(), agents, cases);
  assert.equal(rest.length, 0);
  assert.equal(card.fingerprint, "hawkeye:below_minimum:planted-good-photo-passed");
  assert.equal(card.source, "below_minimum");
  const [m] = card.evidence.measures;
  assert.equal(m.failing_total, 30);
  assert.equal(m.failing.length, FAILING_PER_MEASURE);
  assert.ok(m.failing.every((c, i, xs) => i === 0 || xs[i - 1].at >= c.at), "newest failing case first");
  assert.equal(m.control.case_ref, "photo_verifications:p23", "the passing case closest in time to the newest failure");
  assert.deepEqual(m.days.map((d) => [d.day, d.share, d.cases]), [[YESTERDAY, 0.5, 12], [TODAY, 0.5, 24]]);
  assert.equal(card.evidence.count, 30);
  assert.match(card.summary, /Hawkeye/);
  assert.match(card.summary, /50%/);
});

test("cases of other agents, other measures or outside the window never reach the card", () => {
  const cases = [
    caseRow(1, false),
    { ...caseRow(2, false), agent: "concierge", measure: "operator-agreement" },
    { ...caseRow(3, false), measure: "planted-bad-photo-caught" },
    caseRow(4, false, "2026-10-01"),
  ];
  const [card] = deepAnalysisCards(hawkeyeBelow(), agents, cases);
  assert.deepEqual(card.evidence.measures[0].failing.map((c) => c.case_ref), ["photo_verifications:p1"]);
  assert.equal(card.evidence.measures[0].control, null);
});

test("the sweep's day is the Madrid day, as monitoring_day() is in SQL", () => {
  assert.equal(madridDay(new Date("2026-10-14T22:30:00Z")), "2026-10-15");
  assert.equal(madridDay(new Date("2026-01-14T22:30:00Z")), "2026-01-14");
});

test("a case's context pointer resolves to a row, and a big context is cut", () => {
  assert.deepEqual(parseContextRef("conversation_messages.ai_context id=abc-1"), { table: "conversation_messages", column: "ai_context", key: "id", value: "abc-1" });
  assert.deepEqual(parseContextRef("country_keywords.ai_context country=Spain"), { table: "country_keywords", column: "ai_context", key: "country", value: "Spain" });
  assert.equal(parseContextRef("Langfuse trace only"), null);
  assert.equal(parseContextRef("content_translations.ai_context (prompt of trace t1)"), null);
  assert.deepEqual(trimContext({ a: 1 }), { a: 1 });
  assert.match(trimContext({ prompt: "x".repeat(5000) }), /characters, cut/);
});
