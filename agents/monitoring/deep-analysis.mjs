// Pure half of the deep-analysis cards (docs/agent-factory/agent-minimums.md,
// rule 17 in verification-principles.md): agents below a minimum two days
// running, plus their cases, in; one factory card per agent out. No I/O.

export const FAILING_PER_MEASURE = 20;
const CONTEXT_KEPT = 3000;

const DAY_MS = 86_400_000;
export const shiftDay = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);

/** The Madrid calendar day of an instant, the same day monitoring_day() gives in SQL. */
export function madridDay(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** "conversation_messages.ai_context id=<uuid>" -> where the case's ai_context
 * lives. Null for a case with no stored context (Langfuse only). */
export function parseContextRef(ref) {
  const m = ref?.match(/^([a-z_]+)\.([a-z_]+) ([a-z_]+)=([^\s()]+)$/);
  return m ? { table: m[1], column: m[2], key: m[3], value: m[4] } : null;
}

export function trimContext(value) {
  if (value == null) return null;
  const s = JSON.stringify(value);
  return s.length <= CONTEXT_KEPT ? value : `${s.slice(0, CONTEXT_KEPT)}… (${s.length} characters, cut)`;
}

const pct = (v) => (v == null ? "no cases" : `${Math.round(v * 1000) / 10}%`);
const caseOut = ({ case_ref, at, summary, link, trace_link, context_ref, ai_context }) =>
  ({ case_ref, at, summary, link, trace_link, context_ref, ...(ai_context !== undefined ? { ai_context } : {}) });

/**
 * below: agentsBelowMinimum() output. agents: loadAgents() output.
 * cases: agent_measure_cases rows for the failing measures, both days' windows.
 * Returns one card per agent, fingerprinted by the agent and the measures it
 * is below; the writer refreshes an agent's live card whatever its measures.
 */
export function deepAnalysisCards(below, agents, cases) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return below.map(({ agent, nick, failing }) => {
    const spec = byId.get(agent);
    const measures = failing.map((f) => {
      const means = spec.good.find((m) => m.id === f.measure)?.means ?? null;
      const from = shiftDay(f.days[0].day, -(spec.good.find((m) => m.id === f.measure).window.days - 1));
      const mine = cases
        .filter((c) => c.agent === agent && c.measure === f.measure && c.day >= from && c.day <= f.days[1].day)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const failed = mine.filter((c) => !c.passed);
      const newest = failed[0];
      const control = newest
        ? mine.filter((c) => c.passed).sort((a, b) => Math.abs(Date.parse(a.at) - Date.parse(newest.at)) - Math.abs(Date.parse(b.at) - Date.parse(newest.at)))[0] ?? null
        : null;
      return {
        measure: f.measure,
        means,
        minimum: f.minimum,
        window: f.window,
        days: f.days.map(({ day, cases: n, matching, value }) => ({ day, share: value, cases: n, matching })),
        failing_total: failed.length,
        failing: failed.slice(0, FAILING_PER_MEASURE).map(caseOut),
        control: control && caseOut(control),
      };
    });
    const names = measures.map((m) => m.measure);
    const latest = measures.flatMap((m) => m.failing.map((c) => c.at)).sort().at(-1) ?? null;
    const lines = measures.map((m) => `${m.measure} was ${pct(m.days[0].share)} then ${pct(m.days[1].share)} (minimum ${m.minimum.replace(/^at (least|most) /, "")})`);
    return {
      fingerprint: `${agent}:below_minimum:${names.join("+")}`,
      agent,
      source: "below_minimum",
      title: `${nick}: below its minimum two days running (${names.join(", ")})`,
      summary: `${nick} is below what good looks like on two days in a row: ${lines.join("; ")}. Deep analysis for ${nick} only.`,
      evidence: {
        problem: "below_minimum",
        count: measures.reduce((n, m) => n + m.failing_total, 0),
        measures,
        next: [
          "Read each failing case: what it said, its ai_context, its Langfuse trace, what happened around it.",
          "Fill the hypothesis-by-fact table: one row per explanation, one column per fact, a tick or a cross in every cell.",
          `Propose one change to agents/thinking/${agent}.md or ${nick}'s own code, never another agent's, and never the Minimum or Window lines (rules 11 to 15).`,
        ],
        rule: "docs/agent-factory/agent-minimums.md",
      },
      latest_signal_at: latest,
    };
  });
}
