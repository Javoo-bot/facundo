import { test } from "node:test";
import assert from "node:assert/strict";
import { buildData, flowFor, mergesFromLog, prNumber, receiptsFrom, rulesView } from "./control-app.mjs";

test("each manager gets its own rules with their situations counted by status", () => {
  const groups = [
    { id: "photo-proves-delivery", text: "A photo proves <delivery>.", members: ["a", "b", "c", "gone"] },
    { id: "order-in-clean", text: "Clean orders.", members: ["d"] },
  ];
  const situations = { a: { status: "handled", trigger: "x" }, b: { status: "open" }, c: { status: "weird" }, d: { status: "in-progress" } };
  const r = rulesView(groups, situations);
  assert.equal(r.louis.length, 1);
  assert.deepEqual([r.louis[0].handled, r.louis[0].open, r.louis[0].planned, r.louis[0].members.length], [1, 1, 1, 3]);
  assert.equal(r.louis[0].text, "A photo proves &lt;delivery&gt;.");
  assert.equal(r.donna[0].progress, 1);
  assert.deepEqual(r.harvey, []);
});

test("receipts from Slack are checked, escaped and kept newest first", () => {
  const files = [
    JSON.stringify({ item: "donna:never-worked", kind: "pr", channel: "#donna-orders", note: "Grouped by <situation>", pr: "https://github.com/your-org/agent-factory/pull/45", thread: "javascript:alert(1)", at: "2026-10-25T10:00:00Z" }),
    JSON.stringify({ item: "donna:never-worked", kind: "on-it", channel: "#donna-orders", at: "2026-10-25T09:00:00Z" }),
    JSON.stringify({ item: "x", kind: "deleted-everything", at: "2026-10-25T09:00:00Z" }),
    "not json",
    JSON.stringify({ item: "old", kind: "done", at: "2026-09-01T09:00:00Z" }),
  ];
  const r = receiptsFrom(files, "2026-10-26T08:00:00Z");
  assert.deepEqual(r.map((x) => x.kind), ["pr", "on-it"]);
  assert.equal(r[0].note, "Grouped by &lt;situation&gt;");
  assert.equal(r[0].pr, "https://github.com/your-org/agent-factory/pull/45");
  assert.equal(r[0].thread, null);
});

const NOW = "2026-10-26T08:00:00Z";
const task = (id, agent, status, created_at = "2026-10-20T08:00:00Z", fingerprint = `${agent}:x:${id}`) =>
  ({ id, agent, status, title: `card ${id}`, source: "conversation_escalation", fingerprint, created_at });
const run = (task_id, outcome, pr, started_at = "2026-10-21T08:00:00Z") =>
  ({ task_id, outcome, started_at, finished_at: started_at, notes: "", pr_url: pr ? `https://github.com/your-org/agent-factory/pull/${pr}` : null });
const noAudit = { date: "2026-10-26", fixes: [] };

test("only merges of a factory card branch count, not older PRs with the same number", () => {
  const m = mergesFromLog([
    "2026-10-14T10:00:00Z\tMerge pull request #6 from your-org/factory/card-06bd72ba",
    "2026-07-03T18:59:56Z\tMerge pull request #11 from yogevgab/staging",
    "2026-10-22T11:52:03Z\tMerge pull request #24 from your-org/factory/pr-graph",
  ]);
  assert.deepEqual(m, { 6: "2026-10-14T10:00:00.000Z" });
  assert.equal(prNumber("https://github.com/o/r/pull/37"), 37);
});

test("cards never worked put a manager on top, ahead of a manager with more cards but nothing red", () => {
  const tasks = [
    ...Array.from({ length: 6 }, (_, i) => task(`d${i}`, "concierge", "open")),
    ...Array.from({ length: 8 }, (_, i) => task(`h${i}`, "scout", "dropped")),
  ];
  const runs = tasks.filter((t) => t.agent === "scout").map((t) => run(t.id, "needs-human"));
  const d = buildData({ tasks, runs, events: [], merges: {}, audit: noAudit, now: NOW });
  assert.equal(d.order[0], "donna");
  assert.equal(d.managers.donna.nums.never, 6);
  assert.match(d.managers.donna.facts[0][1], /^6 cards never worked/);
  assert.equal(d.managers.harvey.critCount, 0);
});

test("one red fact outranks two amber ones", () => {
  const tasks = [
    ...Array.from({ length: 5 }, (_, i) => task(`d${i}`, "concierge", "open")),
    task("h0", "scout", "open"), task("h1", "scout", "in-progress"),
  ];
  const runs = [run("h1", "gave-up"), run("h1", "gave-up", null, "2026-10-22T08:00:00Z")];
  const d = buildData({ tasks, runs, events: [], merges: {}, audit: noAudit, now: NOW });
  assert.equal(d.managers.harvey.warnCount, 2);
  assert.deepEqual(d.order.slice(0, 2), ["donna", "harvey"]);
});

test("a merged fix whose card comes back is counted as came back", () => {
  const tasks = [task("a", "hawkeye", "done", "2026-10-14T08:00:00Z", "hawkeye:photo"), task("b", "hawkeye", "open", "2026-10-14T20:00:00Z", "hawkeye:photo")];
  const runs = [run("a", "fixed", 2, "2026-10-14T09:00:00Z")];
  const d = buildData({ tasks, runs, events: [], merges: { 2: "2026-10-14T12:00:00Z" }, audit: noAudit, now: NOW });
  assert.equal(d.managers.louis.nums.back, 1);
  assert.ok(d.managers.louis.facts.some(([t, s]) => t === "crit" && s.includes("#2")));
});

test("a card reopened an hour after a merge stamped in Madrid time still counts as came back", () => {
  const tasks = [task("a", "hawkeye", "done", "2026-10-13T16:55:00+00:00", "hawkeye:review"), task("b", "hawkeye", "in-progress", "2026-10-14T08:00:00+00:00", "hawkeye:review")];
  const merges = mergesFromLog(["2026-10-14T09:00:22+02:00\tMerge pull request #2 from your-org/factory/card-55fc7df0"]);
  const d = buildData({ tasks, runs: [run("a", "fixed", 2, "2026-10-14T06:18:00+00:00")], events: [], merges, audit: noAudit, now: NOW });
  assert.equal(d.managers.louis.nums.back, 1);
});

test("a false pass in the audit shows as said fixed without proof", () => {
  const tasks = [task("a", "concierge", "in-progress")];
  const runs = [run("a", "fixed", 37)];
  const audit = { date: "2026-10-26", fixes: [{ pr: 37, manager: "donna", verdict: "partly", falsePass: true, note: "wiring line untested" }] };
  const d = buildData({ tasks, runs, events: [], merges: {}, audit, now: NOW });
  const said = d.managers.donna.signals.find((s) => s[0].startsWith("Said"));
  assert.equal(said[1], "crit");
  assert.equal(d.managers.donna.cases[0][2][1], "False pass");
  assert.equal(d.desk.waiting, 1);
});

test("a card title with HTML in it reaches the page escaped", () => {
  const tasks = [{ ...task("a", "concierge", "in-progress"), title: 'Client: <img src=x onerror="alert(1)">' }];
  const d = buildData({ tasks, runs: [run("a", "fixed", 40)], events: [], merges: {}, audit: noAudit, now: NOW });
  assert.equal(d.managers.donna.cases[0][1], "Client: &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("the daily snapshot holds each manager's numbers and the desk, dated by the build", () => {
  const tasks = [task("a", "concierge", "open"), task("b", "concierge", "in-progress")];
  const runs = [run("b", "fixed", 41, "2026-10-15T08:00:00Z")];
  const audit = { date: "2026-10-26", fixes: [{ pr: 41, manager: "donna", verdict: "partly", falsePass: true }] };
  const s = buildData({ tasks, runs, events: [], merges: {}, audit, now: NOW }).snapshot;
  assert.equal(s.date, "2026-10-26");
  assert.deepEqual(s.managers.donna, { cards: 2, never: 1, review: 1, decision: 0, fixed: 0, back: 0, red: 1, urgency: 4, falsePass: 1 });
  assert.deepEqual(s.desk, { waiting: 1, decisions: 0, oldestDays: 11 });
});

test("test cards are left out of every count", () => {
  const tasks = [{ ...task("t", "concierge", "open"), title: "TEST do not fix" }];
  const d = buildData({ tasks, runs: [], events: [], merges: {}, audit: noAudit, now: NOW });
  assert.equal(d.managers.donna.nums.cards, 0);
});

test("flow groups cards by the path they took, busiest first", () => {
  const tasks = [task("a", "scout", "open"), task("b", "scout", "open"), task("c", "scout", "in-progress")];
  const runs = [run("c", "gave-up"), run("c", "gave-up", null, "2026-10-22T08:00:00Z")];
  const f = flowFor(tasks, runs);
  assert.deepEqual(f[0], ["Opened", 3, "grey"]);
  assert.deepEqual(f[1], ["Never worked", 2, "crit"]);
  assert.deepEqual(f[2], ["Gave up → Gave up → Waiting for your decision", 1, "crit"]);
});

test("paths past the busiest few are counted as other, so the flow adds up to the cards", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`, "scout", i < 3 ? "open" : "dropped"));
  const runs = tasks.slice(3).map((t, i) => Array.from({ length: i + 1 }, (_, k) => run(t.id, "gave-up", null, `2026-10-2${k}T08:00:00Z`))).flat();
  const f = flowFor(tasks, runs, 2);
  assert.equal(f.slice(1).reduce((s, r) => s + r[1], 0), 8);
  assert.equal(f.at(-1)[0], "Other paths");
});

test("where each card is now adds up to the card count", () => {
  const tasks = [task("a", "concierge", "open"), task("b", "concierge", "open"), task("c", "concierge", "in-progress"), task("d", "concierge", "in-progress"), task("e", "concierge", "done"), task("f", "concierge", "dropped")];
  const runs = [run("b", "gave-up"), run("c", "fixed", 50), run("d", "needs-human")];
  const s = buildData({ tasks, runs, events: [], merges: {}, audit: noAudit, now: NOW }).managers.donna.state;
  assert.deepEqual(s, { never: 1, queued: 1, review: 1, decision: 1, fixed: 1, dropped: 1 });
});

test("an old review queue is the first move, and the desk splits reviews from decisions", () => {
  const tasks = [task("a", "concierge", "in-progress"), task("b", "concierge", "in-progress")];
  const runs = [run("a", "fixed", 41, "2026-10-15T08:00:00Z"), run("b", "needs-human")];
  const d = buildData({ tasks, runs, events: [], merges: {}, audit: noAudit, now: NOW });
  assert.equal(d.moves[0].id, "desk:review");
  assert.equal(d.desk.list[0].pr, 41);
  assert.equal(d.desk.list[0].ageDays, 11);
  assert.equal(d.desk.decisions, 1);
});

test("a garden that logged nothing for over 12 hours is flagged silent", () => {
  const events = [{ case_id: "c", seq: 1, type: "turn", data: {}, created_at: "2026-10-23T18:50:00Z" }];
  const d = buildData({ tasks: [], runs: [], events, merges: {}, audit: noAudit, now: NOW });
  assert.equal(d.silent.hours, 61);
});
