// Pure half of the trouble-paths page: event rows in, step graphs out. No I/O,
// so trouble-paths.test.mjs can drive it with plain objects.
//
// Two graphs, one per place a manager meets trouble:
//   at work  - agent_events (dashboard/lib/caseEvents.ts on the garden branch):
//              what the agents under each manager do on a case once it goes wrong.
//   at the desk - factory_tasks + factory_runs: what happens to the card once the
//              trouble reaches the factory.
// A graph is a directly-follows graph: nodes are steps, an edge A -> B counts
// the cases where B came right after A. Loops stay in (A -> A is a retry).

export const MANAGER_OF = {
  concierge: "donna", babel: "donna", planner: "donna",
  scout: "harvey", bloom: "harvey", sherlock: "harvey", cupid: "harvey", quill: "harvey",
  hawkeye: "louis",
  factory: "jessica",
};

// kind: ok (worked), person (handed on by design), held (waits for the team),
// fail (did not work), step (neutral), edge (start or end).
const N = (id, label, kind, owner = "donna") => ({ id, label, kind, owner });

const STEP_NODE = {
  "close_handled:done": N("closed", "Closes it as handled", "ok"),
  "apologise_reschedule:done": N("apologise", "Apologises, offers a new date", "ok"),
  "ask_client_move_date:done": N("ask-move", "Asks the client to move the date", "ok"),
  "hand_to_person:done": N("hand-off", "Hands it to a person", "person"),
  "hand_to_person:held": N("hand-off-held", "Hand-off waits for the team", "held"),
  "swap_florist:done": N("swap-ok", "Swaps the florist", "ok"),
  "swap_florist:failed": N("swap-failed", "Swap florist fails", "fail"),
  "reoffer_wider:done": N("reoffer-ok", "Reoffers wider", "ok", "harvey"),
  "reoffer_wider:failed": N("reoffer-failed", "Reoffer wider fails", "fail", "harvey"),
  "cold_offer:done": N("cold-ok", "Sends a cold offer", "ok", "harvey"),
  "cold_offer:failed": N("cold-failed", "Cold offer fails", "fail", "harvey"),
};
const MONEY_STEPS = new Set(["refund", "partial_refund", "discount", "pay_florist_more"]);

/** The graph node for one agent_events row, or null for rows that only repeat
 * the next row (a plan is always followed by its step) or that every case gets
 * (a sent "we're on it": only a failed one is trouble). */
export function workNode(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "turn": return N("florist-asks", "A florist asks Concierge", "step");
    case "guard":
      if (d.action === "send") return N("answered", "Concierge answers alone", "ok");
      if (d.action === "propose") return N("proposes", "Concierge passes it to the planner", "step");
      if (d.action === "escalate") return N("to-cx", "Concierge hands it to CX", "person");
      return N("held-terms", "Held: money or terms", "held", "jessica");
    case "plan_requested":
      if (d.trigger === "client_message") return N("client-writes", "A client writes in", "step");
      if (d.trigger === "guard") return N("planner-takes", "Planner takes the case", "step");
      if (d.trigger === "list_ran_out") return N("list-ran-out", "No florist left on the list", "fail", "harvey");
      return N("no-match", "No florist matched", "fail", "harvey");
    case "ack": return d.ok ? null : N("ack-failed", "The 'we're on it' fails", "fail");
    case "model_error": return N("model-error", "Model call fails", "fail");
    case "plan": return null;
    case "step":
      if (MONEY_STEPS.has(d.step)) return N("money-held", "Money step waits for the team", "held", "jessica");
      return STEP_NODE[`${d.step}:${d.outcome}`] ?? N(`${d.step}-${d.outcome}`, `${d.step} ${d.outcome}`, d.outcome === "failed" ? "fail" : "step");
    case "rule_gap": return N("rule-gap", "Writes down a rule gap", "held");
    case "held": return N("case-held", "Case waits for the team", "held");
    default: return N(e.type, e.type, "step");
  }
}

const START = N("start", "Trouble starts", "edge", null);
const END = N("end", "Case stops", "edge", null);

/** Directly-follows graph over sequences of nodes. Edges below minCount are
 * dropped and counted, so the page can say how much it left out. */
export function dfg(sequences, { minCount = 1 } = {}) {
  const nodes = new Map();
  const edges = new Map();
  for (const seq of sequences) {
    const seen = new Set();
    for (let i = 0; i < seq.length; i++) {
      const n = seq[i];
      if (!nodes.has(n.id)) nodes.set(n.id, { ...n, cases: 0 });
      if (!seen.has(n.id)) { nodes.get(n.id).cases++; seen.add(n.id); }
      if (i === 0) continue;
      const k = `${seq[i - 1].id}>${n.id}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  const kept = [];
  let hidden = 0;
  for (const [k, count] of edges) {
    const [from, to] = k.split(">");
    if (count >= minCount) kept.push({ from, to, count });
    else hidden += count;
  }
  const used = new Set(kept.flatMap((e) => [e.from, e.to]));
  return {
    nodes: [...nodes.values()].filter((n) => used.has(n.id)),
    edges: kept.sort((a, b) => b.count - a.count),
    hidden,
  };
}

/** Keeps the `limit` busiest edges, leaving out edges touching `drop` nodes,
 * and the nodes those edges still use. What it leaves out is added to hidden. */
export function busiest(graph, limit, drop = []) {
  const candidates = graph.edges.filter((e) => !drop.includes(e.from) && !drop.includes(e.to));
  const kept = candidates.slice(0, limit);
  const used = new Set(kept.flatMap((e) => [e.from, e.to]));
  const dropped = graph.edges.reduce((s, e) => s + e.count, 0) - kept.reduce((s, e) => s + e.count, 0);
  return { nodes: graph.nodes.filter((n) => used.has(n.id)), edges: kept, hidden: graph.hidden + dropped };
}

/** agent_events rows -> one node sequence per case, in seq order. */
export function workSequences(events) {
  const cases = new Map();
  for (const e of events) {
    if (!cases.has(e.case_id)) cases.set(e.case_id, []);
    cases.get(e.case_id).push(e);
  }
  return [...cases.values()].map((rows) => [
    START,
    ...rows.sort((a, b) => a.seq - b.seq).map(workNode).filter(Boolean),
    END,
  ]);
}

const RUN_NODE = {
  fixed: N("pr", "Mike opens a fix PR", "ok", null),
  "needs-human": N("needs-person", "Mike says it needs a person", "person", null),
  "gave-up": N("gave-up", "Mike gives up", "held", null),
  failed: N("crashed", "Mike's run crashes", "fail", null),
};
const OPENED = N("opened", "Card opens", "edge", null);

function finalNode(task, ranAtAll) {
  if (task.status === "open") return ranAtAll ? N("requeued", "Back in the queue", "held", null) : N("never", "Never worked yet", "fail", null);
  if (task.status === "in-progress") return N("waiting", "Waits for the owner", "held", null);
  if (task.status === "done") return N("done", "Card closed", "ok", null);
  return N("dropped", "Card dropped", "person", null);
}

/** One card -> its node sequence: opened, each run's outcome, where it is now. */
export function deskSequence(task, runs) {
  const mine = runs.filter((r) => r.task_id === task.id).sort((a, b) => a.started_at.localeCompare(b.started_at));
  return [OPENED, ...mine.map((r) => RUN_NODE[r.outcome] ?? N("running", "Mike is running", "step", null)), finalNode(task, mine.length > 0)];
}

// Read from the run's own notes, so the page can be rebuilt daily without a
// person labelling runs. Order matters: a test card is a test whatever it says.
const DESIGNED = /as designed|as intended|by design|built to|not a bug|already fixed|on purpose|practice order|decided a person|found nothing wrong|code and tests intend/i;

/** Why a run did not end in a fix: designed | person | crashed | test | unclear, or null for a fix. */
export function runCause(run, task) {
  if (run.outcome === "fixed" || run.outcome == null) return null;
  if (/^TEST\b/.test(task.title)) return "test";
  if (run.outcome === "failed") return "crashed";
  if (DESIGNED.test(run.notes ?? "")) return "designed";
  if (run.outcome === "needs-human") return "person";
  return "unclear";
}

/** Card keys that are one problem split by free text: the same agent, source and
 * reason prefix (before the first ':' inside the reason) behind many cards. */
export function splitProblems(tasks, { atLeast = 5 } = {}) {
  const groups = new Map();
  for (const t of tasks) {
    const parts = t.fingerprint.split(":");
    const k = parts.slice(0, 4).join(":");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()]
    .filter(([, ts]) => ts.length >= atLeast)
    .map(([key, ts]) => ({ key, cards: ts.length, neverWorked: ts.filter((t) => t.status === "open").length }))
    .sort((a, b) => b.cards - a.cards);
}

/** How often each recovery step worked: {step: {done, failed, held}}. */
export function stepOutcomes(events) {
  const out = {};
  for (const e of events) {
    if (e.type !== "step") continue;
    const s = (out[e.data.step] ??= { done: 0, failed: 0, held: 0 });
    s[e.data.outcome] = (s[e.data.outcome] ?? 0) + 1;
  }
  return out;
}

/** Runs of back-to-back model errors on one case, as {length: count}. */
export function errorStreaks(events) {
  const byCase = new Map();
  for (const e of events) {
    if (!byCase.has(e.case_id)) byCase.set(e.case_id, []);
    byCase.get(e.case_id).push(e);
  }
  const out = {};
  for (const rows of byCase.values()) {
    let n = 0;
    for (const e of [...rows.sort((a, b) => a.seq - b.seq), null]) {
      if (e?.type === "model_error") { n++; continue; }
      if (n) out[n] = (out[n] ?? 0) + 1;
      n = 0;
    }
  }
  return out;
}
