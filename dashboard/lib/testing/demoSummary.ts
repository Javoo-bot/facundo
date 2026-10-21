// Shapes the Demo Control Room's `setup_all` response so it's testable
// without a database — turns a batch of setupOrderScenario() outcomes (one
// per lib/testing/orderScenarios.ts preset) into a stable, presenter-facing
// summary.
//
// Pure and alias-free (relative imports only, no "@/") so plain `node --test`
// can reach it — same convention as lib/testing/demoSink.ts and
// lib/testing/orderScenarios.ts.

export interface ScenarioRunResult {
  scenarioId: string;
  label: string;
  ok: boolean;
  orderId: string | null;
  floristId: string | null;
  assignmentId: string | null;
  steps: string[];
  warnings: string[];
  error: string | null;
}

export interface DemoRunSummary {
  ran: number;
  succeeded: number;
  failed: number;
  results: ScenarioRunResult[];
}

/** Counts, never recomputes from a source of truth other than the results
 *  array itself — `ran` is `results.length`, not a caller-supplied count, so
 *  the two can never disagree. Tolerates a non-array input by treating it as
 *  empty rather than throwing, since this only ever renders a summary. */
export function summarizeScenarioRuns(results: ScenarioRunResult[]): DemoRunSummary {
  const list = Array.isArray(results) ? results : [];
  const succeeded = list.filter((r) => r && r.ok === true).length;
  return { ran: list.length, succeeded, failed: list.length - succeeded, results: list };
}

function readableError(x: unknown): string {
  if (x instanceof Error) return x.message || "Unknown error.";
  if (typeof x === "string" && x.trim()) return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (x && typeof x === "object") {
    try {
      const s = JSON.stringify(x);
      if (s && s !== "{}") return s;
    } catch {
      // fall through to the generic message below
    }
  }
  return "Unknown error.";
}

/**
 * Normalize one setupOrderScenario() outcome (or a thrown error) into a
 * ScenarioRunResult. Never throws: a thrown non-Error, a null outcome, or an
 * outcome missing its `steps`/`warnings` arrays all degrade to `ok: false`
 * with a readable `error` string and empty arrays, rather than blowing up the
 * whole `setup_all` batch over one malformed result.
 */
export function toScenarioRunResult(
  scenarioId: string,
  label: string,
  outcome: {
    ok: boolean;
    orderId?: string;
    floristId?: string | null;
    assignmentId?: string | null;
    steps?: string[];
    warnings?: string[];
    error?: string;
  } | null,
  thrown?: unknown
): ScenarioRunResult {
  const base = { scenarioId: String(scenarioId ?? ""), label: String(label ?? "") };

  if (thrown !== undefined) {
    return {
      ...base, ok: false,
      orderId: null, floristId: null, assignmentId: null,
      steps: [], warnings: [],
      error: readableError(thrown),
    };
  }

  if (!outcome || typeof outcome !== "object") {
    return {
      ...base, ok: false,
      orderId: null, floristId: null, assignmentId: null,
      steps: [], warnings: [],
      error: "No result returned.",
    };
  }

  const ok = outcome.ok === true;
  return {
    ...base,
    ok,
    orderId: typeof outcome.orderId === "string" ? outcome.orderId : null,
    floristId: outcome.floristId ?? null,
    assignmentId: outcome.assignmentId ?? null,
    steps: Array.isArray(outcome.steps) ? outcome.steps : [],
    warnings: Array.isArray(outcome.warnings) ? outcome.warnings : [],
    error: typeof outcome.error === "string" && outcome.error ? outcome.error : ok ? null : "Setup failed.",
  };
}
