// Copies every agent's "What good looks like" measures from agents/thinking/*.md
// (the same parse that builds dashboard/lib/agents/registry.generated.ts) into
// the garden table agent_minimums, so Grafana and the views judge against the
// minimums in the agent files and never a hand-copied number.
//
//   GARDEN_SUPABASE_URL=... GARDEN_SUPABASE_SERVICE_ROLE_KEY=... node agents/monitoring/minimums.mjs
//
// The factory sweep calls syncMinimums on every run, so an edited agent file
// reaches the dashboards within one sweep.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAgents } from "../thinking/parse.mjs";
import { gardenRest } from "./garden-rest.mjs";

export const THINKING_DIR = join(dirname(fileURLToPath(import.meta.url)), "../thinking");

export function minimumRows(agents) {
  return agents.flatMap((a) => a.good.map((m, i) => ({
    agent: a.id,
    measure: m.id,
    nick: a.nick,
    position: i + 1,
    means: m.means,
    data: m.data,
    kind: m.kind,
    op: m.minimum.op,
    minimum: m.minimum.value,
    percent: m.minimum.percent,
    minimum_text: m.minimum.text,
    window_days: m.window.days,
    min_cases: m.window.minCases,
    window_text: m.window.text,
    measurable_now: m.measurableNow,
    measurable: m.measurable,
  })));
}

export async function syncMinimums(db, agents) {
  const rows = minimumRows(agents).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  await db.upsert("agent_minimums", rows, "agent,measure");
  const kept = new Set(rows.map((r) => `${r.agent}/${r.measure}`));
  const stale = (await db.selectAll("agent_minimums?select=agent,measure")).filter((r) => !kept.has(`${r.agent}/${r.measure}`));
  for (const r of stale) await db.rest("DELETE", `agent_minimums?agent=eq.${r.agent}&measure=eq.${r.measure}`);
  return { written: rows.length, removed: stale.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await syncMinimums(gardenRest(), loadAgents(THINKING_DIR));
  console.log(`agent_minimums: ${out.written} measures written, ${out.removed} removed`);
}
