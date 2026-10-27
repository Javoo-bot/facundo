import { test } from "node:test";
import assert from "node:assert/strict";
import { workNode, workSequences, dfg, busiest, deskSequence, runCause, splitProblems, errorStreaks } from "./trouble-paths.mjs";

const ev = (case_id, seq, type, data = {}) => ({ case_id, seq, type, data });

test("a plan row folds into the step that follows it", () => {
  assert.equal(workNode(ev("c", 1, "plan", { chosen: "cold_offer" })), null);
  assert.equal(workNode(ev("c", 2, "step", { step: "cold_offer", outcome: "failed" })).id, "cold-failed");
});

test("every money step lands on one held node owned by Jessica", () => {
  for (const step of ["refund", "partial_refund", "discount", "pay_florist_more"]) {
    const n = workNode(ev("c", 1, "step", { step, outcome: "held" }));
    assert.deepEqual([n.id, n.kind, n.owner], ["money-held", "held", "jessica"]);
  }
});

test("a retry shows as a self-loop with its real count", () => {
  const rows = [
    ev("a", 2, "model_error"), ev("a", 1, "plan_requested", { trigger: "client_message" }),
    ev("a", 3, "model_error"), ev("a", 4, "model_error"),
  ];
  const g = dfg(workSequences(rows));
  const loop = g.edges.find((e) => e.from === "model-error" && e.to === "model-error");
  assert.equal(loop.count, 2);
  assert.equal(g.nodes.find((n) => n.id === "model-error").cases, 1, "a node counts cases, not visits");
});

test("small edges are hidden and counted, and their orphan nodes go with them", () => {
  const seqs = [
    ...Array.from({ length: 3 }, (_, i) => workSequences([ev(`x${i}`, 1, "turn"), ev(`x${i}`, 2, "guard", { action: "send" })])[0]),
    workSequences([ev("y", 1, "turn"), ev("y", 2, "guard", { action: "hold" })])[0],
  ];
  const g = dfg(seqs, { minCount: 2 });
  assert.ok(!g.nodes.some((n) => n.id === "held-terms"));
  assert.equal(g.hidden, 2);
});

test("busiest keeps the top edges, skips start and end, and counts the rest as hidden", () => {
  const g = {
    nodes: ["start", "a", "b", "c", "end"].map((id) => ({ id })),
    edges: [{ from: "start", to: "a", count: 9 }, { from: "a", to: "b", count: 5 }, { from: "b", to: "c", count: 2 }, { from: "c", to: "end", count: 1 }],
    hidden: 3,
  };
  const t = busiest(g, 1, ["start", "end"]);
  assert.deepEqual(t.edges, [{ from: "a", to: "b", count: 5 }]);
  assert.deepEqual(t.nodes.map((n) => n.id), ["a", "b"]);
  assert.equal(t.hidden, 3 + 9 + 2 + 1);
});

test("a card's path: opened, each run, where it is now", () => {
  const task = { id: "t", status: "in-progress" };
  const runs = [
    { task_id: "t", started_at: "2026-10-20", outcome: "needs-human" },
    { task_id: "t", started_at: "2026-10-18", outcome: "gave-up" },
    { task_id: "other", started_at: "2026-10-19", outcome: "fixed" },
  ];
  assert.deepEqual(deskSequence(task, runs).map((n) => n.id), ["opened", "gave-up", "needs-person", "waiting"]);
  assert.deepEqual(deskSequence({ id: "u", status: "open" }, runs).map((n) => n.id), ["opened", "never"]);
});

test("run causes come from the run's own notes", () => {
  const card = { title: "Hawkeye: photo check" };
  assert.equal(runCause({ outcome: "fixed" }, card), null);
  assert.equal(runCause({ outcome: "gave-up", notes: "That part is working as designed." }, card), "designed");
  assert.equal(runCause({ outcome: "needs-human", notes: "Money is the team's call." }, card), "person");
  assert.equal(runCause({ outcome: "failed", notes: "as designed" }, card), "crashed");
  assert.equal(runCause({ outcome: "gave-up", notes: "as designed" }, { title: "TEST cloud-agents: x" }), "test");
  assert.equal(runCause({ outcome: "gave-up", notes: "I looked." }, card), "unclear");
});

test("one reason with free text after it is found as one split problem", () => {
  const tasks = [
    ...["Re: delivered", "Re: prepared", "¿Qué floristería?"].map((s, i) => ({
      fingerprint: `concierge:conversation_escalation:planner:the client wrote about their order: ${s}`, status: i ? "open" : "done" })),
    { fingerprint: "concierge:conversation_escalation:no-facts", status: "open" },
  ];
  assert.deepEqual(splitProblems(tasks, { atLeast: 3 }), [
    { key: "concierge:conversation_escalation:planner:the client wrote about their order", cards: 3, neverWorked: 2 },
  ]);
});

test("error streaks are counted per case and broken by any other row", () => {
  const rows = [
    ev("a", 1, "model_error"), ev("a", 2, "model_error"), ev("a", 3, "plan"), ev("a", 4, "model_error"),
    ev("b", 1, "model_error"), ev("b", 2, "model_error"),
  ];
  assert.deepEqual(errorStreaks(rows), { 1: 1, 2: 2 });
});
