// Turns garden signals into factory cards (agents/factory/schema.sql).
//
//   GARDEN_SUPABASE_URL=... GARDEN_SUPABASE_SERVICE_ROLE_KEY=... node agents/factory/sweep-signals.mjs [--dry-run]
//
// Reads escalated conversations, stuck working-set orders, photo checks that
// did not pass, and failed garden scores; writes one live card per (agent,
// problem). Then judges every agent against its minimums (agents/monitoring/):
// it refreshes agent_minimums from agents/thinking/*.md, copies the Langfuse
// runs some measures need (when LANGFUSE_* is set), reads the daily counts and
// opens one deep-analysis card per agent below a minimum two days running.
// Rerunning refreshes the evidence on the same cards. Garden only: it exits
// before any request if the URL is not the side project.

import { loadAgents } from "../thinking/parse.mjs";
import {
  buildCards, conversationSignals, stuckOrderSignals, photoSignals, gardenScoreSignals,
  LIVE_OFFER, IN_FULFILMENT, NEEDS_PLACING,
} from "./cards.mjs";
import { agentsBelowMinimum, windowOn } from "./thresholds.mjs";
import { gardenRest, inList } from "../monitoring/garden-rest.mjs";
import { syncMinimums, THINKING_DIR } from "../monitoring/minimums.mjs";
import { collectTraces } from "../monitoring/collect.mjs";
import { deepAnalysisCards, madridDay, shiftDay, parseContextRef, trimContext, FAILING_PER_MEASURE } from "../monitoring/deep-analysis.mjs";

const dryRun = process.argv.includes("--dry-run");
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

// One live card per fingerprint: refresh it if it exists, insert it if not.
// A deep-analysis card is one per agent, so it refreshes the agent's live
// below_minimum card even when the measures it fails have changed.
// The unique index on live fingerprints settles a race with a concurrent sweep:
// the loser's insert fails with 409 and it refreshes the winner's card instead.
async function writeCards(cards) {
  const live = await selectAll("factory_tasks?status=in.(open,in-progress)&select=id,fingerprint,agent,source");
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
        [{ id }] = await rest("GET", `factory_tasks?fingerprint=eq.${encodeURIComponent(c.fingerprint)}&status=in.(open,in-progress)&select=id`);
      }
    }
    if (action === "updated") await rest("PATCH", `factory_tasks?id=eq.${id}`, c.source === "below_minimum" ? { ...fresh, fingerprint: c.fingerprint } : fresh);
    result.push({ action, agent: c.agent, count: c.evidence.count, title: c.title });
  }
  return result;
}

const agents = loadAgents(THINKING_DIR);
const nicks = Object.fromEntries(agents.map((a) => [a.id, a.nick]));
const signals = await readSignals();
const { cards, unowned } = buildCards(signals, nicks);

if (!dryRun) {
  const m = await syncMinimums(db, agents);
  console.log(`agent_minimums: ${m.written} measures from agents/thinking, ${m.removed} removed`);
  const t = await collectTraces(db);
  console.log(t.skipped ? `Langfuse runs not copied: ${t.skipped}` : `Langfuse runs copied: ${JSON.stringify(t.counts)}`);
}
const deep = await readBelowMinimum(agents);
console.log(`below a minimum two days running (${deep.today}): ${deep.below.length ? deep.below.map((b) => `${b.nick} (${b.failing.map((f) => f.measure).join(", ")})`).join("; ") : "nobody"}`);
const all = [...deep.cards, ...cards];

console.log(`${signals.length} signals -> ${cards.length} cards, plus ${deep.cards.length} deep-analysis cards${dryRun ? " (dry run, nothing written)" : ""}`);
console.table(dryRun ? all.map((c) => ({ agent: c.agent, count: c.evidence.count, title: c.title })) : await writeCards(all));
for (const c of deep.cards) {
  for (const m of c.evidence.measures) {
    console.log(`${c.agent}/${m.measure}: ${m.failing_total} failing cases (showing ${Math.min(m.failing_total, FAILING_PER_MEASURE)}), control: ${m.control?.case_ref ?? "none"}`);
  }
}
if (unowned.length) {
  console.log("Signals no agent owns (no card):");
  console.table(unowned.map(({ source, key, count, why }) => ({ source, key, count, why })));
}
