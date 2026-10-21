// node --test agents/factory/
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAgents, parseGood } from "../thinking/parse.mjs";
import { agentsBelowMinimum, windowOn } from "./thresholds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agents = loadAgents(join(here, "../thinking"));
const TODAY = "2026-10-14";
const YESTERDAY = "2026-10-13";
const row = (agent, measure, day, cases, matching) => ({ agent, measure, day, cases, matching });

test("every agent file says what good looks like, with at least one measure that decides", () => {
  assert.equal(agents.length, 10);
  for (const a of agents) {
    assert.ok(a.good.length >= 1 && a.good.length <= 3, `${a.id}: 1 to 3 measures`);
    assert.ok(a.good.some((m) => m.kind === "decides"), `${a.id}: needs a measure that decides`);
  }
});

test("Concierge's minimums read as written in concierge.md", () => {
  const concierge = agents.find((a) => a.id === "concierge");
  const agreement = concierge.good.find((m) => m.id === "operator-agreement");
  assert.deepEqual(agreement.minimum, { op: ">=", value: 0.9, percent: true, text: "at least 90%" });
  assert.deepEqual(agreement.window, { days: 2, minCases: 20, text: "rolling 2 days, at least 20 cases" });
  const tone = concierge.good.find((m) => m.id === "tone");
  assert.equal(tone.kind, "advice");
  assert.equal(tone.minimum.value, 0.7);
});

test("an agent below a minimum two days running, with enough cases, gets one entry", () => {
  const rows = [
    row("concierge", "operator-agreement", YESTERDAY, 20, 15),
    row("concierge", "operator-agreement", TODAY, 20, 16),
  ];
  const out = agentsBelowMinimum(agents, rows, TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].agent, "concierge");
  assert.deepEqual(out[0].failing.map((f) => f.measure), ["operator-agreement"]);
  assert.deepEqual(out[0].failing[0].days.map((d) => d.cases), [20, 40]);
});

test("below on one day only is not enough", () => {
  const rows = [
    row("concierge", "operator-agreement", "2026-10-11", 30, 30),
    row("concierge", "operator-agreement", "2026-10-12", 30, 30),
    row("concierge", "operator-agreement", TODAY, 30, 10),
  ];
  assert.deepEqual(agentsBelowMinimum(agents, rows, TODAY), []);
});

test("a day without enough cases is not judged, so it breaks the run", () => {
  const rows = [
    row("concierge", "operator-agreement", "2026-10-12", 5, 0),
    row("concierge", "operator-agreement", YESTERDAY, 5, 0),
    row("concierge", "operator-agreement", TODAY, 30, 0),
  ];
  const [yesterday, today] = [YESTERDAY, TODAY].map((d) => windowOn(agents.find((a) => a.id === "concierge").good[0], rows, d));
  assert.equal(yesterday.judged, false);
  assert.equal(today.below, true);
  assert.deepEqual(agentsBelowMinimum(agents, rows, TODAY), []);
});

test("an advice measure never opens a card, however low", () => {
  const rows = [row("concierge", "tone", YESTERDAY, 10, 0), row("concierge", "tone", TODAY, 10, 0)];
  assert.deepEqual(agentsBelowMinimum(agents, rows, TODAY), []);
});

test("one miss inside a 7-day window keeps a 100% minimum failing on both days", () => {
  const rows = [
    row("cupid", "money-and-contract-handover", "2026-10-10", 1, 0),
    row("cupid", "money-and-contract-handover", TODAY, 3, 3),
  ];
  const out = agentsBelowMinimum(agents, rows, TODAY);
  assert.deepEqual(out.map((o) => o.agent), ["cupid"]);
});

test("a row older than the window does not count", () => {
  const measure = agents.find((a) => a.id === "concierge").good[0];
  const w = windowOn(measure, [row("concierge", "operator-agreement", "2026-10-12", 50, 0)], TODAY);
  assert.equal(w.cases, 0);
  assert.equal(w.below, false);
});

test("two failing measures of one agent are one entry, because the card is per agent", () => {
  const rows = [YESTERDAY, TODAY].flatMap((d) => [
    row("sherlock", "contact-found", d, 40, 10),
    row("sherlock", "email-delivers", d, 40, 30),
  ]);
  const out = agentsBelowMinimum(agents, rows, TODAY);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].failing.map((f) => f.measure).sort(), ["contact-found", "email-delivers"]);
});

test("an at-most minimum fails when the share is above it", () => {
  const measure = { window: { days: 1, minCases: 1 }, minimum: { op: "<=", value: 0.05 } };
  assert.equal(windowOn(measure, [row("x", "y", TODAY, 10, 1)], TODAY).below, true);
  assert.equal(windowOn(measure, [row("x", "y", TODAY, 100, 5)], TODAY).below, false);
});

test("rows for an agent or measure that does not exist are refused", () => {
  assert.throws(() => agentsBelowMinimum(agents, [row("nobody", "x", TODAY, 1, 1)], TODAY), /unknown agent/);
  assert.throws(() => agentsBelowMinimum(agents, [row("concierge", "speed", TODAY, 1, 1)], TODAY), /unknown measure/);
  assert.throws(() => agentsBelowMinimum(agents, [row("concierge", "tone", TODAY, 1, 2)], TODAY), /between 0 and cases/);
});

const measure = (over = {}) => {
  const f = {
    Means: "m", Data: "d", Minimum: "at least 90%", Window: "rolling 2 days, at least 20 cases",
    Kind: "decides", Measurable: "now", ...over,
  };
  return ["### good-one", ...Object.entries(f).map(([k, v]) => `- ${k}: ${v}`)];
};

test("the parser refuses a measure it could not judge", () => {
  assert.equal(parseGood(measure(), "x.md")[0].minimum.value, 0.9);
  assert.throws(() => parseGood([], "x.md"), /1 to 3 measures/);
  assert.throws(() => parseGood(measure({ Minimum: "90 percent" }), "x.md"), /Minimum must read/);
  assert.throws(() => parseGood(measure({ Minimum: "at least 0.9" }), "x.md"), /percentage/);
  assert.throws(() => parseGood(measure({ Window: "two days" }), "x.md"), /Window must read/);
  assert.throws(() => parseGood(measure({ Kind: "maybe" }), "x.md"), /Kind must be/);
  assert.throws(() => parseGood(measure({ Measurable: "soon" }), "x.md"), /Measurable must start/);
  assert.throws(() => parseGood([...measure(), "loose text"], "x.md"), /not "- Field: value"/);
  assert.equal(parseGood(measure({ Kind: "advice", Minimum: "at least 0.7" }), "x.md")[0].minimum.percent, false);
  assert.equal(parseGood(measure({ Measurable: "not measurable yet: needs a table" }), "x.md")[0].measurableNow, false);
});
