// Staff-set wait times, laid over the code defaults in
// lib/sequences/definitions.ts.
//
// Pure and alias-free, like the scheduler it feeds: the funnel's timing stays
// something you can assert on in a unit test rather than something you find
// out about three days after a send.
//
// The contract is deliberately one-directional. An override can only change a
// step's `days`; it can never add a step, remove one, move it between tracks
// or change its anchor. Those are the funnel's SHAPE, which is logic and stays
// in code — see the header of lib/flows/catalog.ts.

import type { SequenceDef } from "../sequences/definitions.ts";

/** `${sequenceId}:${stepKey}` → days. The flat shape a single table read
 * produces, and the shape the API hands the client. */
export type StepTiming = Record<string, number>;

/** `${sequenceId}:${stepKey}` → false, for steps that are switched OFF. Only
 *  the off ones are listed: a step with no entry is on, which keeps "no row"
 *  and "explicitly on" the same thing and means the default can never be
 *  shadowed by a stale copy of itself. */
export type StepEnabled = Record<string, boolean>;

export const MIN_WAIT_DAYS = 0;
/** Ninety days matches the check constraint on sequence_step_timing. Past
 * this a "follow-up" is a cold email with a stale reference in it. */
export const MAX_WAIT_DAYS = 90;

export function timingKey(sequenceId: string, stepKey: string): string {
  return `${sequenceId}:${stepKey}`;
}

/** Is this a wait we are willing to store? Rejects the values that would look
 * like a working funnel and behave like a broken one: NaN and Infinity park a
 * run forever (`anchor + NaN` is NaN, which is never <= now), a negative wait
 * makes a follow-up due before the touch it follows. */
export function isValidWaitDays(days: unknown): days is number {
  return (
    typeof days === "number" &&
    Number.isFinite(days) &&
    days >= MIN_WAIT_DAYS &&
    days <= MAX_WAIT_DAYS
  );
}

/**
 * A copy of `def` with each step's `days` replaced by its override, where one
 * exists and is valid.
 *
 * Invalid entries are DROPPED rather than throwing. This runs inside the tick,
 * against a table a person edits: one bad row must degrade that step to its
 * code default, not stop the whole funnel from sending. The row can only get
 * there through the API's own validation anyway, so this is the second of two
 * gates, not the only one.
 */
export function applyStepTiming(def: SequenceDef, timing: StepTiming | null | undefined): SequenceDef {
  if (!timing) return def;
  let changed = false;
  const steps = def.steps.map((step) => {
    const days = timing[timingKey(def.id, step.key)];
    if (!isValidWaitDays(days)) return step;
    // Compare against the step's ACTUAL wait, not against `days` alone: a step
    // declared in `hours` has no `days`, so `days === step.days` would be false
    // for every override and this would rewrite the step needlessly — and, far
    // worse, an override equal to the current wait would count as a change.
    if (days * 24 === (step.hours ?? (step.days ?? 0) * 24)) return step;
    changed = true;
    // `hours` MUST be cleared. schedule.ts::stepOffsetMs reads `hours` in
    // preference to `days`, so leaving it set would make every staff wait-time
    // edit on /flows silently do nothing for the same-day recruiting steps —
    // the page would show the new number and the funnel would keep the old one.
    const { hours: _dropped, ...rest } = step;
    return { ...rest, days };
  });
  // Returning the same object when nothing was overridden keeps the common
  // case allocation-free and makes "no overrides" provably a no-op.
  return changed ? { ...def, steps } : def;
}

/** The rows a table read produced, as a StepTiming, ignoring anything
 * malformed. Shared by the API and lib/sequences/timingOverrides.ts so the
 * page and the metronome cannot read the same table differently. */
export type StepConfigRow = {
  sequence_id?: unknown;
  step_key?: unknown;
  days?: unknown;
  enabled?: unknown;
};

/** Which steps are switched off. Anything that isn't an explicit `false` is
 *  on — a malformed value must never silence a step by accident. */
export function parseEnabledRows(rows: readonly StepConfigRow[] | null | undefined): StepEnabled {
  const out: StepEnabled = {};
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    if (typeof row.sequence_id !== "string" || typeof row.step_key !== "string") continue;
    if (row.enabled === false) out[timingKey(row.sequence_id, row.step_key)] = false;
  }
  return out;
}

export function parseTimingRows(
  rows: readonly StepConfigRow[] | null | undefined
): StepTiming {
  const out: StepTiming = {};
  for (const row of rows ?? []) {
    // `row` itself can be null: this parses whatever a table read handed back,
    // and it runs inside the tick, where a throw would stop every funnel
    // rather than skip one row.
    if (!row || typeof row !== "object") continue;
    if (typeof row.sequence_id !== "string" || typeof row.step_key !== "string") continue;
    // A row can exist purely to carry `enabled = false`, in which case `days`
    // is null and there is no wait override to report. Null must not become 0
    // here: zero is a real, different instruction ("send immediately").
    if (row.days === null || row.days === undefined) continue;
    // Postgres `numeric` comes back as a string through PostgREST — parsing
    // here is the difference between an override that applies and one that
    // silently doesn't (`"3" !== 3`, and `anchor + "3" * DAY_MS` is fine but
    // `isValidWaitDays("3")` is not).
    const days = typeof row.days === "string" ? Number(row.days) : row.days;
    if (!isValidWaitDays(days)) continue;
    out[timingKey(row.sequence_id, row.step_key)] = days;
  }
  return out;
}
