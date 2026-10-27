// Rebuilds trouble-paths.html from the garden database, read-only. Run from the
// repo root, once a day:
//   node docs/agent-factory/garden-1.2/part-2/build-trouble-paths.mjs
// Needs GARDEN_SUPABASE_URL in the environment and SUPABASE_API_KEY (the garden
// secret key) from FACTORY_ENV_FILE, default
// the repo's .env, like agents/factory/execute-card.mjs. Tables: agent_events,
// factory_tasks, factory_runs. The pure half is trouble-paths.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGER_OF, dfg, busiest, workSequences, deskSequence, runCause, splitProblems, stepOutcomes, errorStreaks,
} from "./trouble-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
// The garden database is not part of this repo: point GARDEN_SUPABASE_URL at your own project.
const GARDEN_URL = process.env.GARDEN_SUPABASE_URL;
if (!GARDEN_URL) throw new Error("GARDEN_SUPABASE_URL is not set (the garden database URL)");
const GARDEN = `${GARDEN_URL.replace(/[/]+$/, "")}/rest/v1/`;

const envFile = process.env.FACTORY_ENV_FILE ?? join(repo, ".env");
const key = readFileSync(envFile, "utf8").match(/^\s*SUPABASE_API_KEY\s*=\s*["']?([^"'\r\n]+)/m)?.[1];
if (!key) throw new Error(`SUPABASE_API_KEY not found in ${envFile}`);

async function all(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(GARDEN + query, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${query}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const [events, tasks, runs] = await Promise.all([
  all("agent_events?select=case_id,seq,type,data,created_at&order=case_id,seq"),
  all("factory_tasks?select=id,agent,title,source,status,fingerprint,created_at&order=created_at"),
  all("factory_runs?select=id,task_id,started_at,finished_at,outcome,notes&order=started_at"),
]);

const now = new Date();
const days = (a, b) => (new Date(b) - new Date(a)) / 864e5;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---- At work ----
const seqs = workSequences(events);
// Every case starts and stops, so those lines say nothing and tangle the rest.
const WORK_EDGES = 24;
const fullWork = dfg(seqs);
const work = busiest(fullWork, WORK_EDGES, ["start", "end"]);
const workMin = work.edges.at(-1)?.count ?? 0;
const eventTimes = events.map((e) => e.created_at).sort();
const lastEventAt = eventTimes.at(-1) ?? null;

const steps = stepOutcomes(events);
const rate = (s) => `${steps[s]?.done ?? 0} of ${(steps[s]?.done ?? 0) + (steps[s]?.failed ?? 0)}`;
const byCase = new Map();
for (const e of events) (byCase.get(e.case_id) ?? byCase.set(e.case_id, []).get(e.case_id)).push(e);
let ladder = 0, ladderHeld = 0;
for (const rows of byCase.values()) {
  const failed = new Set(rows.filter((e) => e.type === "step" && e.data.outcome === "failed").map((e) => e.data.step));
  if (failed.size >= 2) { ladder++; if (rows.some((e) => e.type === "held")) ladderHeld++; }
}
const modelErrors = events.filter((e) => e.type === "model_error");
const full429 = modelErrors.filter((e) => /HTTP 429/.test(e.data.detail ?? "")).length;
const streaks = errorStreaks(events);
const longStreaks = Object.entries(streaks).filter(([n]) => +n >= 5).reduce((s, [, c]) => s + c, 0);
const longestStreak = Math.max(0, ...Object.keys(streaks).map(Number));
const fallbackPlans = events.filter((e) => e.type === "plan" && e.data.fallback).length;
const moneyHeld = events.filter((e) => e.type === "step" && e.data.outcome === "held" && e.data.step !== "hand_to_person").length;
const ruleGaps = events.filter((e) => e.type === "rule_gap").length;
const designedGaps = events.filter((e) => e.type === "rule_gap" && /only the team|Policy holds|without the team|only the team answers/i.test(e.data.gap ?? "")).length;

// ---- At the desk ----
const deskSeqs = tasks.map((t) => ({ manager: MANAGER_OF[t.agent] ?? "none", seq: deskSequence(t, runs) }));
const desk = Object.fromEntries(["all", "harvey", "donna", "louis", "jessica"].map((m) => [m,
  dfg(deskSeqs.filter((d) => m === "all" || d.manager === m).map((d) => d.seq))]));
const taskById = new Map(tasks.map((t) => [t.id, t]));
const causes = {};
for (const r of runs) { const c = runCause(r, taskById.get(r.task_id)); if (c) causes[c] = (causes[c] ?? 0) + 1; }
const notFixed = runs.filter((r) => r.outcome && r.outcome !== "fixed").length;
const split = splitProblems(tasks)[0] ?? null;
const firstRun = new Map();
for (const r of runs) if (!firstRun.has(r.task_id)) firstRun.set(r.task_id, r.started_at);
const waitDays = tasks.filter((t) => firstRun.has(t.id)).map((t) => days(t.created_at, firstRun.get(t.id)));
const neverWorked = tasks.filter((t) => t.status === "open" && !firstRun.has(t.id)).length;
const cardSpan = Math.max(1, days(tasks[0]?.created_at ?? now, now));
const gaveUpTwice = [...new Set(runs.map((r) => r.task_id))]
  .filter((id) => runs.filter((r) => r.task_id === id && r.outcome === "gave-up").length >= 2)
  .map((id) => taskById.get(id).agent);
const waiting = tasks.filter((t) => t.status === "in-progress").length;

const silentHours = lastEventAt ? days(lastEventAt, now) * 24 : null;
const data = {
  builtAt: now.toISOString(),
  window: { firstEventAt: eventTimes[0] ?? null, lastEventAt, firstCardAt: tasks[0]?.created_at ?? null },
  silent: silentHours != null && silentHours > 12 ? { hours: Math.round(silentHours), since: lastEventAt } : null,
  totals: { events: events.length, cases: seqs.length, cards: tasks.length, runs: runs.length, hiddenWork: work.hidden, workMin },
  work, desk,
  runCauses: causes,
  roots: [
    split && {
      id: "split", graph: "desk", tone: "crit", owner: "jessica",
      highlight: [["opened", "never"]],
      title: "One problem is filed as many cards",
      why: "Each client email's subject becomes part of the card's name, so every email opens a new card.",
      seen: `${split.cards} of ${tasks.length} cards share one reason; ${split.neverWorked} of them were never worked.`,
      root: "The planner writes the client's email subject into its hand-off reason, and the sweep turns each distinct reason into its own card. Every new email from a client becomes a new card, so the queue fills with copies of one rule: a client wrote in, and a person answers.",
      evidence: [`card key ${split.key}:<subject>`, "origin/garden dashboard/lib/conversations.ts:265", "agents/factory/cards.mjs:147 (fingerprint)"],
      alone: "Grouping cards is factory code, so the change needs a person (the doctor lane). Once it lands, closing the duplicate cards is a call an agent can make alone and log.",
    },
    {
      id: "designed", graph: "both", tone: "warn", owner: "donna",
      highlight: [["hand-off", "rule-gap"], ["money-held", "rule-gap"], ["gave-up", "gave-up"], ["opened", "gave-up"]],
      title: "Working as designed is filed as a fault",
      why: "A hand-off the rules ask for looks the same as one caused by a fault, so Mike chases problems that aren't there.",
      seen: `At work: ${designedGaps} of ${ruleGaps} rule gaps name a hold the rules require (money, terms, a person decides). At the desk: ${causes.designed ?? 0} of ${notFixed} runs that did not end in a fix said the card was working as designed, already fixed, or a practice order.`,
      root: "A hand-off the rule asks for and a hand-off caused by a fault leave the same mark. The planner writes a rule gap for both, and the sweep counts escalations without asking whether the situation's handling in lifecycle.ts already says to escalate. Mike then spends a run finding out that nothing is broken.",
      evidence: ["rule_gap rows: “only the team decides”, “Policy holds money decisions”", "factory_runs notes: “working as designed”, “already fixed”, “practice orders”", "lifecycle.ts branches with status handled"],
      alone: "Dropping a card whose situation is handled by design serves an existing rule. Topic 4 can let a manager do it alone and list it for the weekly review.",
    },
    {
      id: "ladder", graph: "work", tone: "crit", owner: "harvey",
      highlight: [["swap-failed", "planner-takes"], ["reoffer-failed", "planner-takes"], ["reoffer-failed", "list-ran-out"], ["cold-failed", "list-ran-out"], ["cold-failed", "rule-gap"], ["planner-takes", "cold-failed"]],
      title: "No florist nearby: the planner climbs a ladder that never holds",
      why: "The planner keeps trying steps that almost never work here, because the area has no spare florists.",
      seen: `Reoffer wider worked ${rate("reoffer_wider")} times, cold offer ${rate("cold_offer")}, swap florist ${rate("swap_florist")}. ${ladder} cases tried two or more of them and failed each time; ${ladderHeld} of those ended waiting for the team.`,
      root: "When the list runs out, the planner picks the next recovery step from the same list every time, without looking at how often that step has worked. In the garden there is nobody new within 45 km and no shop outside the network on the list, so each step fails for the same reason and the next one is tried anyway. The cause sits upstream: the area has no spare florists.",
      evidence: ["step details: “nobody new within 45 km”, “no shop outside the network on the list”", "dashboard/lib/planPolicy.ts (garden branch)", "Harvey's rule area-has-florists"],
      alone: "Skipping a step that has not worked in the last 50 tries on the same reason serves the existing rule. A planner change like that can go through the free lane.",
    },
    {
      id: "retry", graph: "work", tone: "crit", owner: "donna",
      highlight: [["model-error", "model-error"]],
      title: "A full model pool is retried, not avoided",
      why: "The planner retries a full model pool again and again instead of switching to the fallback.",
      seen: `${modelErrors.length} model calls failed; ${full429} were “no room left” in the free model pool (HTTP 429). ${longStreaks} cases retried 5 or more times in a row (longest ${longestStreak}). The fallback model was used ${fallbackPlans} times.`,
      root: "The planner retries the same pool while the pool is full, and the fallback path never fires, so a busy hour turns into a run of identical failures and then a rule gap that blames the message (“the planner model keeps failing on messages like this one”). That rule gap is the wrong lesson: the message was fine.",
      evidence: ["model_error detail: pool \"tools\" has no deployment with room left", "plan rows with fallback = true: 0", "topic 5, question 4 (retry loops)"],
      alone: "Backing off and switching to the fallback is a fix for a problem the rule already covers. It touches the model budget (the $1 a day setup), so the owner sees it before merge.",
    },
    {
      id: "queue", graph: "desk", tone: "warn", owner: "jessica",
      highlight: [["opened", "never"], ["gave-up", "gave-up"], ["pr", "waiting"], ["needs-person", "waiting"]],
      title: "Cards arrive faster than Mike works them, and none ever close",
      why: "Mike works one card per run, twice a day, and nothing closes a card when its problem stops.",
      seen: `${round(tasks.length / cardSpan)} cards a day open, ${round(runs.length / cardSpan)} runs a day work them. Median wait for a first run: ${round(median(waitDays))} days. ${neverWorked} cards never worked, ${waiting} waiting with a PR or a question. Cards retried after giving up twice: ${gaveUpTwice.join(", ") || "none"}.`,
      root: "The executor takes one card per run, twice a day, and nothing ever closes a card: the sweep refreshes cards but does not close them when the signal stops. A card that gave up comes back after 24 hours with the same brief, so Mike repeats the same search.",
      evidence: ["agents/factory/README.md, step 6 (“not built yet”)", ".github/workflows/factory-execute.yml (07:00 and 13:00 UTC)", "factory_runs per card"],
      alone: "Fixing the split cards and the designed-behaviour cards first shrinks the queue without more runs. A gave-up card should go back to its manager for a new brief, not straight back to Mike.",
    },
  ].filter(Boolean),
};

const safe = (s) => s.replace(/<\//g, "<\\/");
const page = readFileSync(join(here, "trouble-paths.template.html"), "utf8").replace("__DATA__", () => safe(JSON.stringify(data)));
writeFileSync(join(here, "trouble-paths.html"), page);
console.log(`trouble-paths.html: ${events.length} events on ${seqs.length} cases, ${tasks.length} cards, ${runs.length} runs${data.silent ? `; garden silent for ${data.silent.hours} h` : ""}`);
