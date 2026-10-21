// Which agents are below one of their minimums: the pure half of the rule in
// docs/agent-factory/agent-minimums.md. No I/O. sweep-signals.mjs feeds it the
// garden view agent_measure_daily (agents/monitoring/schema.sql).
//
// A row is one agent's measure on one day, as counts:
//   { agent: "concierge", measure: "operator-agreement", day: "2026-10-14", cases: 12, matching: 11 }
// `matching` is how many of the day's cases meet the measure's Means, so the
// day's share is matching / cases. The window in the agent's file adds up the
// rows of its last N days before the minimum is compared.

const DAY_MS = 86_400_000;

function shiftDay(day, by) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
}

/** The measure's window ending on `day`: the summed counts, and whether there
 * were enough cases to judge it at all. */
export function windowOn(measure, rows, day) {
  const from = shiftDay(day, -(measure.window.days - 1));
  let cases = 0;
  let matching = 0;
  for (const r of rows) {
    if (r.day < from || r.day > day) continue;
    cases += r.cases;
    matching += r.matching;
  }
  const judged = cases >= measure.window.minCases;
  const value = cases ? matching / cases : null;
  const { op, value: min } = measure.minimum;
  const below = judged && (op === ">=" ? value < min : value > min);
  return { day, cases, matching, value, judged, below };
}

/** Agents below a minimum that decides, on `today` and the day before, each
 * day with enough cases. One entry per agent, because the rule opens one
 * deep-analysis card per agent, listing every measure it failed. */
export function agentsBelowMinimum(agents, rows, today) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const grouped = new Map();
  for (const r of rows) {
    const agent = byId.get(r.agent);
    if (!agent) throw new Error(`row for unknown agent "${r.agent}"`);
    if (!agent.good.some((m) => m.id === r.measure)) throw new Error(`row for unknown measure "${r.agent}/${r.measure}"`);
    if (!Number.isInteger(r.cases) || !Number.isInteger(r.matching) || r.matching < 0 || r.matching > r.cases) {
      throw new Error(`row ${r.agent}/${r.measure} ${r.day}: matching must be a whole number between 0 and cases`);
    }
    const key = `${r.agent}/${r.measure}`;
    grouped.set(key, [...(grouped.get(key) ?? []), r]);
  }

  const out = [];
  for (const agent of agents) {
    const failing = [];
    for (const measure of agent.good) {
      if (measure.kind !== "decides") continue;
      const mine = grouped.get(`${agent.id}/${measure.id}`) ?? [];
      const days = [shiftDay(today, -1), today].map((d) => windowOn(measure, mine, d));
      if (days.every((d) => d.below)) failing.push({ measure: measure.id, minimum: measure.minimum.text, window: measure.window.text, days });
    }
    if (failing.length) out.push({ agent: agent.id, nick: agent.nick, failing });
  }
  return out;
}
