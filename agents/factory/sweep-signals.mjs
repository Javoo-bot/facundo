// Turns garden signals into factory cards (agents/factory/schema.sql).
//
//   GARDEN_SUPABASE_URL=... GARDEN_SUPABASE_SERVICE_ROLE_KEY=... node agents/factory/sweep-signals.mjs [--dry-run]
//
// Reads escalated conversations, stuck working-set orders, photo checks that
// did not pass, and failed garden scores. Each is an alert, placed once
// (factory_alerts) on one of the 13 general rules: exact by situation id, else
// a Haiku near match via OpenRouter (OPENROUTER_API_KEY, $0.50 a Madrid day;
// without the key those alerts wait). A rule's card opens at 3 alerts in 7
// days, closes 7 quiet days after its fix merged, and a new alert reopens the
// same card (general-rules.mjs). Then judges every agent against its minimums (agents/monitoring/):
// it refreshes agent_minimums from agents/thinking/*.md, copies the Langfuse
// runs some measures need (when LANGFUSE_* is set), reads the daily counts and
// opens one deep-analysis card per agent below a minimum two days running.
// The owner's open ideas (garden_ideas, written on the Garden pulse page) and big
// rule-gap clusters (Phase 4's agent_events) that pass the cluster rule
// (cluster-rule.mjs) become cards too, sources 'human' and 'cluster'. Two
// failed executor runs of one kind in 24 hours become one 'factory' card for
// the doctor lane; outages (Claude login, rate limit, Anthropic 5xx) are only
// printed. Order-loop errors in the garden's PostHog become 'error' cards
// (errorCards); that source is off until GARDEN_POSTHOG_PERSONAL_API_KEY is set.
// Rerunning refreshes the evidence on the same cards; any card whose fix merged
// and whose signal then stayed quiet 7 days is closed as done (quietCards).
// Garden only: it exits before any request if the URL is not the side project.

import { loadAgents } from "../thinking/parse.mjs";
import {
  conversationSignals, stuckOrderSignals, photoSignals, gardenScoreSignals, ideaCards, clusterCards, factoryCards, errorCards, FACTORY_WINDOW_MS, ERROR_EVENTS,
  LIVE_OFFER, IN_FULFILMENT, NEEDS_PLACING,
} from "./cards.mjs";
import { alertId, placeAlerts, ruleCardPlan, quietCards, quietDaysLeft, CARD_LIFE, DAY_MS } from "./general-rules.mjs";
import { agentsBelowMinimum, windowOn } from "./thresholds.mjs";
import { CLUSTER_RULE } from "./cluster-rule.mjs";
import { gardenRest, inList } from "../monitoring/garden-rest.mjs";
import { syncMinimums, THINKING_DIR } from "../monitoring/minimums.mjs";
import { collectTraces } from "../monitoring/collect.mjs";
import { deepAnalysisCards, madridDay, shiftDay, parseContextRef, trimContext, FAILING_PER_MEASURE } from "../monitoring/deep-analysis.mjs";

import { WAITING, findAnswer, issueRef, resumePatch } from "./questions.mjs";

const dryRun = process.argv.includes("--dry-run");
// Live cards hold their fingerprint (schema.sql factory_tasks_live_fingerprint):
// a card waiting for the owner's answer is refreshed, never duplicated.
const LIVE = ["open", "in-progress", WAITING].join(",");
const db = gardenRest();
const { rest, selectAll } = db;
const list = (xs) => `(${xs.join(",")})`;

// The garden began on 2026-10-13 (Madrid). Older rows came over with the staging
// copy; the owner asked to leave them out (2026-10-14). Same cutoff as garden_epoch()
// in agents/monitoring/schema.sql.
const GARDEN_EPOCH = "2026-10-12T22:00:00Z";

async function readSignals() {
  const [settings] = await rest("GET", "app_settings?id=eq.1&select=active_order_tags,active_order_countries,run_all_orders");
  const criteria = {
    activeOrderTags: settings?.active_order_tags ?? [],
    activeOrderCountries: settings?.active_order_countries ?? [],
    runAllOrders: settings?.run_all_orders ?? false,
  };
  const statuses = [...NEEDS_PLACING, "reaching_out", ...IN_FULFILMENT];
  const [conversations, orders, liveOffers, photos, scores] = await Promise.all([
    selectAll(`conversations?status=eq.awaiting_human&escalated_at=gte.${GARDEN_EPOCH}&select=id,kind,order_id,escalation_reason,last_inbound_at,created_at`),
    selectAll(`orders?deleted_at=is.null&created_at=gte.${GARDEN_EPOCH}&status=in.${list(statuses)}&select=id,order_name,status,delivery_at,tags,delivery_address,worklist_at,escalation_reason`),
    selectAll(`order_assignments?status=in.${list(LIVE_OFFER)}&select=order_id,sla_deadline_at`),
    selectAll(`photo_verifications?verdict=in.(review,fail)&created_at=gte.${GARDEN_EPOCH}&select=id,order_id,verdict,confidence,providers,created_at`),
    selectAll("garden_scores?passed=is.false&select=scenario_id,actual_outcome,notes,scored_at,scenario:garden_scenarios(stage_id,branch_id,title,expected_outcome,shopify_order_id)"),
  ]);
  return [
    ...conversationSignals(conversations),
    ...stuckOrderSignals({ orders, liveOffers, criteria }),
    ...photoSignals(photos),
    ...gardenScoreSignals(scores),
  ];
}

// A table a later phase adds (agent_events) is skipped, not fatal.
async function optional(label, path) {
  try {
    return await selectAll(path);
  } catch (e) {
    if (e.status === 404 || /PGRST205|42P01|does not exist|Could not find/.test(e.message)) {
      console.log(`${label}: not there yet, skipped`);
      return [];
    }
    throw e;
  }
}

async function readSteering(nicks) {
  const today = madridDay();
  const from = shiftDay(today, -(CLUSTER_RULE.windowDays - 1));
  const [ideas, events, daily] = await Promise.all([
    optional("garden_ideas", "garden_ideas?status=eq.open&select=id,title,body,agent,status,created_by,created_at,updated_at"),
    optional("agent_events", `agent_events?or=(type.eq.rule_gap,data->>rule_gap.not.is.null)&created_at=gte.${shiftDay(from, -1)}&select=case_id,seq,type,data,created_at`),
    optional("agent_cases_daily", `agent_cases_daily?day=gte.${from}&select=day,cases`),
  ]);
  const unassigned = ideas.filter((i) => !i.agent).length;
  if (unassigned) console.log(`${unassigned} open idea(s) name no agent yet: no card until one is picked on Garden pulse`);
  const totals = new Map(daily.map((d) => [d.day, d.cases]));
  return [...ideaCards(ideas, nicks), ...clusterCards(events, nicks, totals, { today })];
}

// The executor's own failures of the last 24 hours (the doctor lane).
async function readFactoryRuns() {
  const since = new Date(Date.now() - FACTORY_WINDOW_MS).toISOString();
  const [runs, parked] = await Promise.all([
    selectAll(`factory_runs?outcome=eq.failed&finished_at=gte.${since}&select=id,task_id,outcome,finished_at,notes,task:factory_tasks(source)`),
    selectAll("factory_tasks?source=eq.factory&status=eq.parked&select=fingerprint"),
  ]);
  return factoryCards(runs, { parked: parked.map((p) => p.fingerprint) });
}

// Order-loop errors from the garden's PostHog (HogQL query API). Needs a
// personal API key with read access to the garden project; the capture token
// the worker writes with cannot read.
async function readErrors() {
  const key = process.env.GARDEN_POSTHOG_PERSONAL_API_KEY;
  if (!key) { console.log("errors source off: no read key"); return { cards: [], held: [] }; }
  const host = (process.env.GARDEN_POSTHOG_API_HOST || (process.env.GARDEN_POSTHOG_HOST || "https://eu.posthog.com").replace("://eu.i.", "://eu.").replace("://us.i.", "://us.")).replace(/\/$/, "");
  const project = process.env.GARDEN_POSTHOG_PROJECT_ID || "@current";
  const query = `select event, timestamp, properties from events where event in (${ERROR_EVENTS.map((e) => `'${e}'`).join(", ")}) and timestamp > now() - interval 1 day order by timestamp desc limit 2000`;
  const res = await fetch(`${host}/api/projects/${project}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`PostHog query ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const events = ((await res.json()).results ?? []).map(([event, timestamp, properties]) => ({
    event,
    timestamp: new Date(timestamp).toISOString(),
    properties: typeof properties === "string" ? JSON.parse(properties) : properties ?? {},
  }));
  const since = new Date(Date.now() - FACTORY_WINDOW_MS).toISOString();
  const [live, recent] = await Promise.all([
    selectAll("factory_tasks?source=eq.error&status=in.(open,in-progress)&select=fingerprint"),
    selectAll(`factory_tasks?source=eq.error&created_at=gte.${since}&select=id`),
  ]);
  const out = errorCards(events, { live: live.map((t) => t.fingerprint), openedToday: recent.length });
  console.log(`errors source: ${events.length} PostHog events -> ${out.cards.length} error cards${out.held.length ? `, ${out.held.length} held back by the 3-a-day cap` : ""}`);
  return out;
}

// Fills in each shown failing case's ai_context from the row it points at.
async function attachContexts(cards) {
  const wanted = new Map();
  for (const c of cards) for (const m of c.evidence.measures) for (const f of m.failing) {
    const ref = parseContextRef(f.context_ref);
    if (!ref) continue;
    const k = `${ref.table}|${ref.column}|${ref.key}`;
    wanted.set(k, [...(wanted.get(k) ?? []), ref.value]);
  }
  const found = new Map();
  for (const [k, values] of wanted) {
    const [table, column, key] = k.split("|");
    const rows = await rest("GET", `${table}?${key}=in.${inList([...new Set(values)])}&select=${key},${column}`);
    for (const r of rows) found.set(`${table}.${column} ${key}=${r[key]}`, trimContext(r[column]));
  }
  for (const c of cards) for (const m of c.evidence.measures) for (const f of m.failing) {
    if (parseContextRef(f.context_ref)) f.ai_context = found.get(f.context_ref) ?? null;
  }
}

async function readBelowMinimum(agents) {
  const today = madridDay();
  const yesterday = shiftDay(today, -1);
  const maxWindow = Math.max(...agents.flatMap((a) => a.good.map((m) => m.window.days)));
  const known = new Set(agents.flatMap((a) => a.good.map((m) => `${a.id}/${m.id}`)));
  const daily = await selectAll(`agent_measure_daily?day=gte.${shiftDay(yesterday, -maxWindow)}&select=agent,measure,day,cases,matching`);
  const rows = daily.filter((r) => known.has(`${r.agent}/${r.measure}`));
  for (const r of daily) if (!known.has(`${r.agent}/${r.measure}`)) console.warn(`measure ${r.agent}/${r.measure} is computed in SQL but not in any agent file; ignored`);

  // The dashboards read agent_daily_metrics; the card rule reads thresholds.mjs.
  // Say so if the two ever judge a day differently.
  const sql = await selectAll(`agent_daily_metrics?day=in.(${yesterday},${today})&decides=is.true&select=day,agent,measure,below`);
  for (const s of sql) {
    const measure = agents.find((a) => a.id === s.agent)?.good.find((m) => m.id === s.measure);
    if (!measure) continue;
    const js = windowOn(measure, rows.filter((r) => r.agent === s.agent && r.measure === s.measure), s.day);
    if (js.below !== s.below) console.warn(`agent_daily_metrics and thresholds.mjs disagree on ${s.agent}/${s.measure} ${s.day}: SQL below=${s.below}, JS below=${js.below}`);
  }

  const below = agentsBelowMinimum(agents, rows, today);
  if (!below.length) return { today, below, cards: [] };
  const from = shiftDay(yesterday, -maxWindow);
  const cases = [];
  for (const b of below) for (const f of b.failing) {
    cases.push(...await selectAll(`agent_measure_cases?agent=eq.${b.agent}&measure=eq.${f.measure}&day=gte.${from}&select=agent,measure,case_ref,at,day,passed,summary,link,trace_link,context_ref&order=at.desc`));
  }
  const cards = deepAnalysisCards(below, agents, cases);
  await attachContexts(cards);
  return { today, below, cards };
}

// The near match's one model call (OpenRouter, OpenAI shape: the tool
// arguments come back as a JSON string). usage.include asks for the cost.
async function askHaiku(request) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, usage: { include: true } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const costUsd = j.usage?.cost ?? null;
  // A billed answer that is no use still costs: the cap counts it (placeAlerts).
  try {
    const call = j.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("openrouter: no tool call");
    return { args: JSON.parse(call.function.arguments), costUsd };
  } catch (e) {
    e.costUsd = costUsd;
    throw e;
  }
}

// New signals become alerts, placed once on a general rule; an alert already
// placed and still there gets its last_seen_at moved to now, so its rule is not
// quiet. Then the rule alerts placed or seen in the last window come back for
// the card plan. A dry run never calls the model: its spend would not be kept.
async function readAlerts(signals) {
  const known = new Set((await selectAll("factory_alerts?select=alert_id")).map((a) => a.alert_id));
  const fresh = new Map();
  const still = new Set();
  for (const s of signals) {
    const id = alertId(s);
    if (known.has(id)) still.add(id);
    else fresh.set(id, s);
  }
  const today = madridDay();
  const now = new Date().toISOString();
  if (!dryRun) {
    const ids = [...still];
    for (let i = 0; i < ids.length; i += 100) await rest("PATCH", `factory_alerts?alert_id=in.${encodeURIComponent(inList(ids.slice(i, i + 100)))}`, { last_seen_at: now }, { Prefer: "return=minimal" });
  }
  const spent = (await selectAll(`factory_near_calls?day=eq.${today}&select=cost_usd`)).reduce((n, a) => n + Number(a.cost_usd), 0);
  const ask = process.env.OPENROUTER_API_KEY && !dryRun ? askHaiku : null;
  const out = await placeAlerts([...fresh.values()], { ask, spentUsd: spent });
  if (!dryRun && out.calls.length) await rest("POST", "factory_near_calls", out.calls.map((c) => ({ ...c, called_at: now, day: today })), { Prefer: "return=minimal" });
  const rows = out.placed.map((a) => ({ alert_id: a.alert_id, source: a.source, key: a.key, label: a.label, ref: a.ref ?? {}, rule_id: a.rule_id, match: a.match, why: a.why, cost_usd: a.cost_usd ?? 0, placed_at: now, last_seen_at: now, placed_day: today }));
  if (!dryRun && rows.length) await rest("POST", "factory_alerts", rows, { Prefer: "resolution=ignore-duplicates,return=minimal" });
  const since = new Date(Date.now() - CARD_LIFE.openWindowDays * DAY_MS).toISOString();
  const recent = await selectAll(`factory_alerts?rule_id=not.is.null&or=(placed_at.gte.${since},last_seen_at.gte.${since})&select=alert_id,source,key,label,ref,rule_id,match,placed_at,last_seen_at`);
  const alerts = dryRun ? [...recent.map((a) => (still.has(a.alert_id) ? { ...a, last_seen_at: now } : a)), ...rows.filter((r) => r.rule_id)] : recent;
  console.log(`alerts: ${fresh.size} new -> ${out.placed.filter((a) => a.match === "exact").length} exact, ${out.placed.filter((a) => a.match === "near").length} near, ${out.placed.filter((a) => a.match === "none").length} no rule, ${out.waiting.length} waiting; ${still.size} still there; near match spent $${out.spentUsd.toFixed(3)} today${ask ? "" : dryRun ? " (dry run: no model call)" : " (near match off: no OPENROUTER_API_KEY)"}`);
  return { alerts, placed: out.placed, waiting: out.waiting };
}

// open: insert; refresh: new evidence; reopen: the same row back to open.
// last_seen_at is the rule's latest alert sighting, not now, so quiet days count from it.
async function writeRuleCards(plan) {
  const now = new Date().toISOString();
  const result = [];
  for (const p of plan) {
    const { fingerprint, agent, source, manager, general_rule, ...fresh } = p.card;
    if (p.action === "open") {
      try {
        const [{ id }] = await rest("POST", "factory_tasks", { ...p.card }, { Prefer: "return=representation" });
        result.push({ ...p, id });
      } catch (e) {
        if (e.status !== 409) throw e;
        console.log(`rule card ${general_rule}: opened by a concurrent sweep`);
      }
      continue;
    }
    // A reopened card starts its life again: an old question and answer would
    // otherwise name its branch and brief (questions.mjs).
    const reopen = p.action === "reopen" ? { status: "open", merged_at: null, closed_at: null, reopened_at: now, reopened_count: p.reopened_count, question: null, answer: null } : {};
    await rest("PATCH", `factory_tasks?id=eq.${p.id}${p.action === "reopen" ? "&status=eq.done" : ""}`, { ...fresh, ...reopen, updated_at: now });
    result.push(p);
  }
  return result;
}

// One live card per fingerprint: refresh it if it exists, insert it if not.
// A deep-analysis card is one per agent, so it refreshes the agent's live
// below_minimum card even when the measures it fails have changed.
// The unique index on live fingerprints settles a race with a concurrent sweep:
// the loser's insert fails with 409 and it refreshes the winner's card instead.
async function writeCards(cards) {
  const live = await selectAll(`factory_tasks?status=in.(${LIVE})&select=id,fingerprint,agent,source`);
  const idOf = new Map(live.map((t) => [t.fingerprint, t.id]));
  const deepOf = new Map(live.filter((t) => t.source === "below_minimum").map((t) => [t.agent, t.id]));
  const now = new Date().toISOString();
  const result = [];
  for (const c of cards) {
    const fresh = { title: c.title, summary: c.summary, evidence: c.evidence, latest_signal_at: c.latest_signal_at, last_seen_at: now, updated_at: now };
    let id = idOf.get(c.fingerprint) ?? (c.source === "below_minimum" ? deepOf.get(c.agent) : undefined);
    let action = "updated";
    if (!id) {
      try {
        [{ id }] = await rest("POST", "factory_tasks", { ...fresh, agent: c.agent, source: c.source, fingerprint: c.fingerprint }, { Prefer: "return=representation" });
        action = "new";
      } catch (e) {
        if (e.status !== 409) throw e;
        [{ id }] = await rest("GET", `factory_tasks?fingerprint=eq.${encodeURIComponent(c.fingerprint)}&status=in.(${LIVE})&select=id`);
      }
    }
    if (action === "updated") await rest("PATCH", `factory_tasks?id=eq.${id}`, c.source === "below_minimum" ? { ...fresh, fingerprint: c.fingerprint } : fresh);
    result.push({ id, action, agent: c.agent, count: c.evidence.count, title: c.title, ideaId: c.ideaId });
  }
  return result;
}

// ---- the owner's answers (questions.mjs) -------------------------------------------
// A card waiting for an answer asked its question on a draft PR or an issue.
// Read the comments there (PR reviews too) and reopen the card on the first
// "answer: <letter>" from a person; the executor then works it with the answer
// in its brief. Read-only on GitHub: needs GH_TOKEN with issues and
// pull-requests read.

async function github(path, token) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function commentsOn(url, since, token) {
  const ref = issueRef(url);
  if (!ref) return [];
  const comments = await github(`repos/${ref.repo}/issues/${ref.number}/comments?per_page=100&since=${encodeURIComponent(since ?? "1970-01-01T00:00:00Z")}`, token);
  if (!/\/pull\//.test(url)) return comments;
  const reviews = await github(`repos/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`, token);
  return [...comments, ...reviews.map((r) => ({ ...r, created_at: r.submitted_at }))];
}

async function readAnswers() {
  const waiting = await selectAll(`factory_tasks?status=eq.${WAITING}&select=id,title,question`);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!waiting.length) return console.log("0 card(s) waiting for the owner's answer");
  if (!token) return console.log(`answers off: no GitHub token; ${waiting.length} card(s) waiting for the owner's answer`);
  for (const t of waiting) {
    const where = [t.question?.pr_url, t.question?.issue_url].filter(Boolean);
    if (!where.length) { console.log(`  ${t.id}: its question has no PR or issue to read`); continue; }
    const comments = (await Promise.all(where.map((u) => commentsOn(u, t.question.asked_at, token)))).flat();
    const answer = findAnswer(comments, t.question);
    if (!answer) { console.log(`  ${t.id} still waiting: ${where[0]}`); continue; }
    console.log(`  ${t.id} answered ${answer.letter} by ${answer.by}${dryRun ? " (dry run, not reopened)" : ", reopened"}: ${t.title}`);
    if (!dryRun) await rest("PATCH", `factory_tasks?id=eq.${t.id}&status=eq.${WAITING}`, resumePatch(t, answer));
  }
}

const agents = loadAgents(THINKING_DIR);
// PostHog down or a bad key skips the error cards, never the rest of the sweep.
const errors = await readErrors().catch((err) => {
  console.log(`errors source skipped: ${err.message}`);
  return { cards: [], held: [] };
});
const nicks = Object.fromEntries(agents.map((a) => [a.id, a.nick]));
const signals = await readSignals();
const placing = await readAlerts(signals);
const ruleCards = await selectAll("factory_tasks?source=eq.rule&select=id,general_rule,status,closed_at,reopened_count");
const rulePlan = ruleCardPlan({ alerts: placing.alerts, cards: ruleCards });

if (!dryRun) {
  const m = await syncMinimums(db, agents);
  console.log(`agent_minimums: ${m.written} measures from agents/thinking, ${m.removed} removed`);
  const t = await collectTraces(db);
  console.log(t.skipped ? `Langfuse runs not copied: ${t.skipped}` : `Langfuse runs copied: ${JSON.stringify(t.counts)}`);
}
const deep = await readBelowMinimum(agents);
console.log(`below a minimum two days running (${deep.today}): ${deep.below.length ? deep.below.map((b) => `${b.nick} (${b.failing.map((f) => f.measure).join(", ")})`).join("; ") : "nobody"}`);
const steering = await readSteering(nicks);
const factory = await readFactoryRuns();
const all = [...deep.cards, ...steering, ...factory.cards, ...errors.cards];

console.log(`${signals.length} signals -> rule cards: ${rulePlan.map((p) => `${p.action} ${p.card.general_rule} (${p.card.evidence.count})`).join(", ") || "no change"}; plus ${deep.cards.length} deep-analysis, ${steering.length} idea/cluster and ${factory.cards.length} factory and ${errors.cards.length} error cards${dryRun ? " (dry run, nothing written)" : ""}`);
if (factory.outages.length) {
  console.log("Factory runs that failed on an outage, not a code bug (no card):");
  console.table(factory.outages);
}
if (dryRun) console.table([...rulePlan.map((p) => p.card), ...all].map((c) => ({ agent: c.agent, source: c.source, count: c.evidence.count, title: c.title })));
else {
  const ruled = await writeRuleCards(rulePlan);
  if (ruled.length) console.table(ruled.map((p) => ({ action: p.action, manager: p.card.manager, count: p.card.evidence.count, title: p.card.title })));
  const written = await writeCards(all);
  console.table(written.map(({ action, agent, count, title }) => ({ action, agent, count, title })));
  // An idea that became a card leaves the open list; the page links its card.
  for (const w of written.filter((w) => w.ideaId)) {
    await rest("PATCH", `garden_ideas?id=eq.${w.ideaId}&status=eq.open`, { status: "turned-into-card", card_id: w.id, updated_at: new Date().toISOString() });
  }
}
// After the refresh above: a card whose fix merged and whose signal then
// stayed quiet CARD_LIFE.quietDays is done.
const live = await selectAll("factory_tasks?status=in.(open,in-progress)&select=id,title,source,status,last_seen_at,merged_at,runs:factory_runs(finished_at)");
const quiet = quietCards(live);
const counting = live.filter((t) => t.merged_at && !quiet.includes(t.id));
console.log(`${counting.length} merged card(s) counting quiet days${counting.length ? `: ${counting.map((t) => `${t.title} (${quietDaysLeft(t)} left)`).join("; ")}` : ""}`);
console.log(`${quiet.length} card(s) quiet ${CARD_LIFE.quietDays} days after the merge ${dryRun ? "would be closed" : "closed as done"}${quiet.length ? ":" : ""}`);
for (const id of quiet) {
  console.log(`  ${id} ${live.find((t) => t.id === id).title}`);
  const now = new Date().toISOString();
  if (!dryRun) await rest("PATCH", `factory_tasks?id=eq.${id}&status=in.(open,in-progress)`, { status: "done", closed_at: now, updated_at: now });
}
// GitHub down or a bad token leaves the cards waiting, never stops the sweep.
await readAnswers().catch((err) => console.log(`answers skipped: ${err.message}`));
for (const c of deep.cards) {
  for (const m of c.evidence.measures) {
    console.log(`${c.agent}/${m.measure}: ${m.failing_total} failing cases (showing ${Math.min(m.failing_total, FAILING_PER_MEASURE)}), control: ${m.control?.case_ref ?? "none"}`);
  }
}
// Never dropped: alerts no general rule fits, and alerts waiting for a near match.
const noRule = placing.placed.filter((a) => a.match === "none");
if (noRule.length) {
  console.log("New alerts no general rule fits (kept in factory_alerts, no card):");
  console.table(noRule.map(({ source, key, label, why }) => ({ source, key, label, why })));
}
if (placing.waiting.length) {
  console.log("Alerts waiting for a near match (tried again next sweep):");
  console.table(placing.waiting.map(({ alert, why }) => ({ source: alert.source, key: alert.key, why })));
}
