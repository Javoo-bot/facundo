// Pure half of the Manager Control Room: garden rows in, the page's data out.
// No I/O, so control-app.test.mjs drives it with plain objects. The build
// (build-control-app.mjs) fetches the rows and writes control-app.html.
//
// Every fact on the page is a rule over counts here, never hand-written, so
// the page can be rebuilt every morning without a person.

import { MANAGER_OF, deskSequence, runCause, splitProblems, stepOutcomes, errorStreaks } from "../part-2/trouble-paths.mjs";

export const MANAGERS = {
  donna: { name: "Donna", role: "Order-loop manager", reads: "Concierge, Babel" },
  harvey: { name: "Harvey", role: "Supply manager", reads: "Scout, Bloom, Sherlock, Cupid, Quill" },
  louis: { name: "Louis", role: "Proof manager", reads: "Hawkeye" },
};

const DAY = 864e5;
const days = (a, b) => Math.floor((new Date(b) - new Date(a)) / DAY);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const isTest = (t) => /^TEST\b/.test(t.title);
// Card titles can carry a client's email subject; the page renders strings as HTML.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const prNumber = (url) => Number(/\/pull\/(\d+)/.exec(url ?? "")?.[1]) || null;

/** git log lines of the garden branch, "<iso date>\t<subject>" -> {prNumber: mergedAt}.
 * Factory fixes merge into garden, and only merges of a factory/card-* branch
 * count: older history carries PR numbers from another repo. */
export function mergesFromLog(lines) {
  const out = {};
  for (const line of lines) {
    const [at, subject = ""] = line.split("\t");
    const n = /^Merge pull request #(\d+) from [\w.-]+\/factory\/card-/.exec(subject)?.[1];
    // git writes local offsets (+02:00); the database writes UTC. Compare in UTC.
    if (n && !out[n]) out[n] = new Date(at).toISOString();
  }
  return out;
}

const STEP_LABEL = {
  never: "Never worked", pr: "Draft PR", waiting: "Waiting for you", done: "Closed", dropped: "Dropped",
  "gave-up": "Gave up", "needs-person": "Needed a person", crashed: "Crashed", requeued: "Back in the queue", running: "Mike is running",
};
function pathTone(ids) {
  if (ids[0] === "never" || ids.includes("crashed") || ids.filter((i) => i === "gave-up").length >= 2) return "crit";
  if (ids.includes("gave-up") || ids.includes("needs-person")) return "warn";
  if (ids.at(-1) === "done") return "ok";
  return ids.at(-1) === "dropped" ? "grey" : "";
}

/** Where one manager's cards went: one row per path after "opened", busiest first. */
export function flowFor(tasks, runs, limit = 6) {
  const paths = new Map();
  for (const t of tasks) {
    const ids = deskSequence(t, runs).slice(1).map((n) => n.id);
    const key = ids.join(">");
    paths.set(key, (paths.get(key) ?? 0) + 1);
  }
  // "Waiting for you" means two things: a fix to review, or a question to decide.
  const label = (i, ids) => i === "waiting" ? (ids.includes("pr") ? "Waiting for your review" : "Waiting for your decision") : STEP_LABEL[i] ?? i;
  const sorted = [...paths.entries()].sort((a, b) => b[1] - a[1]);
  const rows = sorted.slice(0, limit)
    .map(([key, count]) => { const ids = key.split(">"); return [ids.map((i) => label(i, ids)).join(" → "), count, pathTone(ids)]; });
  const rest = sorted.slice(limit).reduce((s, [, c]) => s + c, 0);
  if (rest) rows.push([`Other paths`, rest, "grey"]);
  return [["Opened", tasks.length, "grey"], ...rows];
}

/** What happened at work, by the manager who owns it (agent_events). */
export function workSignals(events) {
  const steps = stepOutcomes(events);
  const rate = (s) => `${steps[s]?.done ?? 0} of ${(steps[s]?.done ?? 0) + (steps[s]?.failed ?? 0)}`;
  const byCase = new Map();
  for (const e of events) (byCase.get(e.case_id) ?? byCase.set(e.case_id, []).get(e.case_id)).push(e);
  let ladder = 0, ladderHeld = 0;
  for (const rows of byCase.values()) {
    const failed = new Set(rows.filter((e) => e.type === "step" && e.data?.outcome === "failed").map((e) => e.data.step));
    if (failed.size >= 2) { ladder++; if (rows.some((e) => e.type === "held")) ladderHeld++; }
  }
  const streaks = errorStreaks(events);
  const modelErrors = events.filter((e) => e.type === "model_error");
  return {
    ladder, ladderHeld,
    rates: { reoffer: rate("reoffer_wider"), cold: rate("cold_offer"), swap: rate("swap_florist") },
    modelErrors: modelErrors.length,
    full429: modelErrors.filter((e) => /HTTP 429/.test(e.data?.detail ?? "")).length,
    longStreaks: Object.entries(streaks).filter(([n]) => +n >= 5).reduce((s, [, c]) => s + c, 0),
    longestStreak: Math.max(0, ...Object.keys(streaks).map(Number)),
    fallback: events.filter((e) => e.type === "plan" && e.data?.fallback).length,
    ruleGaps: events.filter((e) => e.type === "rule_gap").length,
    designedGaps: events.filter((e) => e.type === "rule_gap" && /only the team|Policy holds|without the team/i.test(e.data?.gap ?? "")).length,
  };
}

/** One manager's numbers, facts, signals and fixes. */
export function managerView(id, { tasks, runs, merges, audit, work, now }) {
  const mine = tasks.filter((t) => !isTest(t) && MANAGER_OF[t.agent] === id);
  const runsOf = (t) => runs.filter((r) => r.task_id === t.id);
  const prOf = (t) => runsOf(t).map((r) => prNumber(r.pr_url)).filter(Boolean).at(-1) ?? null;
  const merged = mine.filter((t) => merges[prOf(t)]);
  const cameBack = merged.filter((t) => tasks.some((o) => o.id !== t.id && o.fingerprint === t.fingerprint && new Date(o.created_at) > new Date(merges[prOf(t)])));
  const never = mine.filter((t) => t.status === "open" && runsOf(t).length === 0);
  const oldestNever = never.length ? Math.max(...never.map((t) => days(t.created_at, now))) : 0;
  const split = splitProblems(mine)[0];
  const gaveUpTwice = mine.filter((t) => runsOf(t).filter((r) => r.outcome === "gave-up").length >= 2);
  const notFixed = mine.flatMap(runsOf).filter((r) => r.outcome && r.outcome !== "fixed");
  const designed = notFixed.filter((r) => runCause(r, mine.find((t) => t.id === r.task_id)) === "designed").length;
  const unclosed = merged.filter((t) => t.status === "in-progress");
  const checked = audit.fixes.filter((f) => f.manager === id && f.verdict !== "no-fix");
  const falsePass = checked.filter((f) => f.falsePass);

  // Each fact is [tone, text, id]. The id is stable across days, so a person's
  // "on it" or "snoozed" on the page (its db) still points at it tomorrow.
  const facts = [];
  if (never.length) facts.push([never.length >= 5 ? "crit" : "warn",
    `${plural(never.length, "card")} never worked, the oldest for ${plural(oldestNever, "day")}.` +
    (split && split.neverWorked >= 5 ? ` ${split.neverWorked} of them are one problem, split by the client's email subject.` : ""), `${id}:never-worked`]);
  if (falsePass.length) facts.push(["crit", `${falsePass.length} of ${plural(checked.length, "checked fix", "checked fixes")} ${falsePass.length === 1 ? "passes its" : "pass their"} tests with the main fix removed (audit of ${audit.date}).`, `${id}:false-pass`]);
  if (cameBack.length) facts.push(["crit", `${plural(cameBack.length, "merged fix", "merged fixes")} came back: ${cameBack.map((t) => `#${prOf(t)}`).join(", ")}.`, `${id}:came-back`]);
  if (id === "donna" && work.longStreaks) facts.push(["crit", `Retries a full AI pool: ${plural(work.longStreaks, "case")} retried 5 or more times in a row; the backup model was used ${work.fallback} times.`, "donna:retry-full-pool"]);
  if (id === "harvey" && work.ladder) facts.push(["crit", `"No florist nearby": ${plural(work.ladder, "case")} failed two or more recovery steps. Cold offers worked ${work.rates.cold} times.`, "harvey:ladder"]);
  if (gaveUpTwice.length) facts.push(["warn", `${plural(gaveUpTwice.length, "card")} gave up twice and went back to Mike with the same brief.`, `${id}:gave-up-twice`]);
  if (designed >= 3) facts.push(["warn", `${designed} of ${notFixed.length} runs that didn't end in a fix found it was working as designed.`, `${id}:designed`]);
  if (unclosed.length) facts.push(["warn", `${plural(unclosed.length, "merged card")} never closed.`, `${id}:unclosed`]);

  facts.sort((a, b) => (a[0] === "crit" ? 0 : 1) - (b[0] === "crit" ? 0 : 1));

  const roots = [];
  if (id === "donna" && work.longStreaks) roots.push(["crit", "A full AI pool is retried, not avoided", `${work.modelErrors} model calls failed, ${work.full429} of them "no room left" in the free pool. ${work.longStreaks} cases retried 5+ times in a row (longest ${work.longestStreak}). Backup model used ${work.fallback} times.`]);
  if (id === "donna" && work.designedGaps) roots.push(["warn", "Working as designed is filed as a fault", `${work.designedGaps} of ${work.ruleGaps} rule gaps are holds the rules require (money, terms, a person decides).`]);
  if (id === "donna" && split && split.cards >= 5) roots.push(["crit", "One problem is filed as many cards", `${split.cards} cards share one reason; ${split.neverWorked} of them were never worked.`]);
  if (id === "harvey" && work.ladder) roots.push(["crit", "No florist nearby: a ladder that never holds", `Reoffer wider worked ${work.rates.reoffer} times, cold offer ${work.rates.cold}, swap florist ${work.rates.swap}. ${work.ladderHeld} of the failed cases ended waiting for the team.`]);
  for (const t of cameBack) roots.push(["crit", "A fix that came back", `#${prOf(t)}, "${esc(t.title)}", reopened after it merged.`]);

  const repeats = (id === "donna" ? work.longStreaks : id === "harvey" ? work.ladder : 0);
  const signals = [
    ["Saw it, didn't act", never.length >= 5 ? "crit" : never.length ? "warn" : "ok", plural(never.length, "card"), never.length ? `Never picked up. The oldest has waited ${plural(oldestNever, "day")}.` : "Every card was picked up."],
    checked.length || cameBack.length
      ? ["Said \"fixed\" without proof", falsePass.length || cameBack.length ? "crit" : "ok", `${falsePass.length + cameBack.length} of ${checked.length + cameBack.length}`,
        [falsePass.length && `Tests stay green with the main fix removed: ${falsePass.map((f) => `#${f.pr}`).join(", ")} (audit of ${audit.date}).`, cameBack.length && `Came back after merge: ${cameBack.map((t) => `#${prOf(t)}`).join(", ")}.`].filter(Boolean).join(" ") || `Every checked fix held (audit of ${audit.date}).`]
      : ["Said \"fixed\" without proof", "todo", "Not audited", "No fix of this manager's has been re-checked yet."],
    ["Keeps trying what fails", repeats || gaveUpTwice.length ? "crit" : "ok", repeats ? plural(repeats, "case") : plural(gaveUpTwice.length, "card"),
      [id === "donna" && repeats && "Retried the full AI pool 5 or more times in a row.", id === "harvey" && repeats && "Tried two or more recovery steps that keep failing.", gaveUpTwice.length && `${plural(gaveUpTwice.length, "card")} gave up twice with the same brief.`].filter(Boolean).join(" ") || "Nothing repeated."],
    ["Held or gave up without a reason", "todo", "Not recorded", "Needs the manager log from Part 2: dropped_as_designed and to_jessica, each with a reason."],
  ];

  const auditBy = new Map(audit.fixes.map((f) => [f.pr, f]));
  const cases = mine.filter(prOf).sort((a, b) => prOf(b) - prOf(a)).slice(0, 8).map((t) => {
    const n = prOf(t), a = auditBy.get(n);
    const label = a ? (a.falsePass ? ["crit", "False pass"] : a.verdict === "proves-the-fix" ? ["ok", "Proves the fix"] : a.verdict === "no-fix" ? ["grey", "No fix"] : ["warn", "Partly proven"])
      : cameBack.includes(t) ? ["crit", "Came back"] : merges[n] ? ["ok", "Merged, quiet so far"] : ["grey", "Waiting for your review"];
    // The fix's life as four steps: opened, tests prove it, merged, stayed quiet. null = not known yet.
    const life = {
      url: `https://github.com/your-org/agent-factory/pull/${n}`,
      proven: a ? (a.falsePass ? false : a.verdict === "proves-the-fix" ? true : null) : null,
      merged: Boolean(merges[n]),
      quiet: merges[n] ? !cameBack.includes(t) : null,
      backAt: cameBack.includes(t) ? tasks.filter((o) => o.id !== t.id && o.fingerprint === t.fingerprint && new Date(o.created_at) > new Date(merges[n])).map((o) => o.created_at).sort()[0] : null,
    };
    return [`#${n}`, esc(a?.note ? `${t.title}: ${a.note}` : t.title), label, life];
  });

  // Where every card is now; the parts add up to the card count.
  const state = { never: never.length, queued: 0, review: 0, decision: 0, fixed: 0, dropped: 0 };
  for (const t of mine) {
    if (t.status === "open") { if (runsOf(t).length) state.queued++; }
    else if (t.status === "in-progress") { if (merges[prOf(t)]) state.fixed++; else if (prOf(t)) state.review++; else state.decision++; }
    else if (t.status === "done") state.fixed++;
    else state.dropped++;
  }

  const critCount = facts.filter((f) => f[0] === "crit").length;
  const warnCount = facts.length - critCount;
  return {
    urgency: critCount * 3 + warnCount, warnCount,
    ...MANAGERS[id],
    nums: { cards: mine.length, worked: mine.filter((t) => runsOf(t).length).length, merged: merged.length, back: cameBack.length, never: never.length, prs: mine.filter(prOf).length },
    closed: mine.filter((t) => t.status === "done").length,
    state, facts, critCount, roots, signals, cases,
    lead: facts[0] ? `${MANAGERS[id].name}'s biggest problem today: ${facts[0][1].charAt(0).toLowerCase()}${facts[0][1].slice(1)}` : `Nothing needs you on ${MANAGERS[id].name} today.`,
    flow: flowFor(mine, runs),
  };
}

// Which general rules each manager owns (Part 1: docs/agent-factory/garden-1.2/README.md, section 5).
export const RULES_OF = {
  harvey: ["area-has-florists", "only-ready-shops", "offer-reaches-shop", "recruiting-honest-once"],
  donna: ["order-in-clean", "order-on-map", "offer-gets-answer", "accepted-gets-delivered", "florist-questions-answered", "shopify-agrees", "someone-watching"],
  louis: ["photo-proves-delivery"],
};
const SITUATION_STATUS = new Set(["handled", "in-progress", "planned", "open"]);

/** Each manager's general rules with their situations' status, from general-rules.json and the
 * situations in dashboard/lib/lifecycle.ts. A member missing from lifecycle.ts is skipped. */
export function rulesView(groups, situations) {
  const out = {};
  for (const [id, ruleIds] of Object.entries(RULES_OF)) {
    out[id] = ruleIds.map((rid) => groups.find((g) => g.id === rid)).filter(Boolean).map((g) => {
      const members = g.members.filter((m) => situations[m]).map((m) => ({
        id: m, status: SITUATION_STATUS.has(situations[m].status) ? situations[m].status : "planned",
        trigger: esc(String(situations[m].trigger ?? "").slice(0, 160)),
      }));
      const count = (s) => members.filter((m) => m.status === s).length;
      return { id: g.id, text: esc(g.text ?? ""), members, handled: count("handled"), progress: count("in-progress"), planned: count("planned"), open: count("open") };
    });
  }
  return out;
}

const RECEIPT_KINDS = new Set(["on-it", "pr", "done", "designed"]);
const safeUrl = (u) => (typeof u === "string" && /^https:\/\/(github\.com|[\w-]+\.slack\.com|app\.slack\.com|claude\.ai)\//.test(u) ? u : null);

/** Receipts Claude in Slack leaves on the control-room-log branch (one JSON file each), checked and
 * escaped, newest first. A file that isn't a valid receipt is skipped, never shown half-read. */
export function receiptsFrom(files, now, days = 14) {
  const since = new Date(now) - days * 864e5;
  const out = [];
  for (const raw of files) {
    let r; try { r = JSON.parse(raw); } catch { continue; }
    if (!r || typeof r.item !== "string" || !RECEIPT_KINDS.has(r.kind) || !r.at || Number.isNaN(Date.parse(r.at))) continue;
    if (Date.parse(r.at) < since) continue;
    out.push({
      item: r.item.slice(0, 80), kind: r.kind, at: new Date(r.at).toISOString(),
      channel: esc(String(r.channel ?? "").slice(0, 40)), note: esc(String(r.note ?? "").slice(0, 400)),
      pr: safeUrl(r.pr), thread: safeUrl(r.thread),
    });
  }
  return out.sort((a, b) => new Date(b.at) - new Date(a.at));
}

/** The whole page's data. */
export function buildData({ tasks, runs, events, merges, audit, now, receipts = [], rules = {} }) {
  const work = workSignals(events);
  const managers = Object.fromEntries(Object.keys(MANAGERS).map((id) => [id, managerView(id, { tasks, runs, merges, audit, work, now })]));
  // Red facts weigh three amber ones; ties go to the manager with more cards.
  const order = Object.keys(managers).sort((a, b) => managers[b].urgency - managers[a].urgency || managers[b].nums.cards - managers[a].nums.cards);
  const live = tasks.filter((t) => !isTest(t) && MANAGER_OF[t.agent] in MANAGERS);
  const lastPr = (t) => runs.filter((r) => r.task_id === t.id && r.pr_url).at(-1);
  const waiting = live.filter((t) => t.status === "in-progress")
    .map((t) => ({ t, pr: lastPr(t) }))
    .filter(({ pr }) => pr && !merges[prNumber(pr.pr_url)])
    .map(({ t, pr }) => ({ pr: prNumber(pr.pr_url), url: pr.pr_url, title: esc(t.title), manager: MANAGER_OF[t.agent], ageDays: days(pr.finished_at ?? pr.started_at, now) }))
    .sort((a, b) => b.ageDays - a.ageDays);
  const decisions = live.filter((t) => t.status === "in-progress" && !lastPr(t)).length;
  const lastMerge = Object.values(merges).sort().at(-1) ?? null;
  const lastEventAt = events.map((e) => e.created_at).sort().at(-1) ?? null;
  const silentHours = lastEventAt ? (new Date(now) - new Date(lastEventAt)) / 36e5 : null;
  const silent = silentHours != null && silentHours > 12 ? { hours: Math.round(silentHours), since: lastEventAt } : null;
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const oldestDays = waiting[0]?.ageDays ?? 0;

  // Today's moves: the few things that unblock the most, in this order.
  const moves = [];
  if (waiting.length && oldestDays > 3) moves.push({ id: "desk:review", tone: "crit", title: `Review ${plural(waiting.length, "waiting fix", "waiting fixes")}`, detail: `The oldest has waited ${plural(oldestDays, "day")}. Nothing reaches the garden until you merge.`, action: "desk" });
  if (silent) moves.push({ id: "garden:silent", tone: "crit", title: "Get the garden running again", detail: `It has logged nothing for ${silent.hours} hours, so nothing new can be measured.`, action: "copy",
    copy: `The garden simulation (branch garden, the side-project database) has written no agent_events since ${silent.since}. Find why it stopped and restart it. Read docs/agent-factory/garden.md and docs/agent-factory/garden-deploy.md first; deploy only by pushing to origin/garden.` });
  for (const id of order) for (const [tone, text, fid] of managers[id].facts) {
    if (moves.length >= 3) break;
    if (tone === "crit") moves.push({ id: fid, tone, title: `${MANAGERS[id].name}: ${text}`, detail: "", action: "manager", manager: id });
  }

  // What the data itself says changed: fixes opened, merged, came back, runs that gave up.
  const taskById = new Map(live.map((t) => [t.id, t]));
  const activity = [];
  for (const r of runs) {
    const t = taskById.get(r.task_id); if (!t) continue;
    const who = MANAGER_OF[t.agent], n = prNumber(r.pr_url), at = r.finished_at ?? r.started_at;
    if (n) activity.push({ at, kind: "pr", manager: who, text: `Mike opened fix #${n}: ${esc(t.title)}`, url: r.pr_url });
    else if (r.outcome === "gave-up") activity.push({ at, kind: "gave-up", manager: who, text: `Mike gave up on: ${esc(t.title)}` });
    else if (r.outcome === "needs-human") activity.push({ at, kind: "decision", manager: who, text: `Mike asked for your decision on: ${esc(t.title)}` });
    if (n && merges[n]) activity.push({ at: merges[n], kind: "merged", manager: who, text: `Fix #${n} merged`, url: r.pr_url });
  }
  for (const id of order) for (const [n, , , life] of managers[id].cases) if (life.backAt) activity.push({ at: life.backAt, kind: "came-back", manager: id, text: `Fix ${n} came back after merge` });
  activity.sort((a, b) => new Date(b.at) - new Date(a.at));

  // One small record of today's numbers. The page saves it once per day in its own database, which
  // is what draws the trend lines and the "since yesterday" marks (the build itself keeps no history).
  const snapshot = {
    date: new Date(now).toISOString().slice(0, 10),
    managers: Object.fromEntries(Object.entries(managers).map(([id, m]) => [id, {
      cards: m.nums.cards, never: m.state.never, review: m.state.review, decision: m.state.decision,
      fixed: m.state.fixed, back: m.nums.back, red: m.critCount, urgency: m.urgency,
      falsePass: audit.fixes.filter((f) => f.manager === id && f.falsePass).length,
    }])),
    desk: { waiting: waiting.length, decisions, oldestDays },
  };

  return {
    builtAt: new Date(now).toISOString(),
    window: { from: tasks.map((t) => t.created_at).sort()[0] ?? null, to: new Date(now).toISOString() },
    silent, order, managers, moves, activity: activity.slice(0, 25), receipts, snapshot, rules,
    desk: { waiting: waiting.length, list: waiting, decisions, oldestDays, lastMerge: lastMerge && iso(lastMerge) },
    audit: { date: audit.date, fixes: audit.fixes },
  };
}
