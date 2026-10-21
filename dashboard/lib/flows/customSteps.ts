// Duplicated funnel touches: the one thing that adds a step at runtime.
//
// Pure, alias-free, no I/O — the same constraint the rest of lib/flows holds,
// so what a duplicate does to a funnel is a unit test rather than something
// you find out about three days after a send.
//
// The whole design is "copy a step we already know how to send":
//
//   * A custom step borrows a built-in step's SHAPE — its paragraphs, its
//     voice, whose name signs it, which namespace its copy lives under. It
//     cannot invent a track, a channel or a sequence, so there is no shape the
//     engine has never rendered.
//   * It gets its own key (`t2__copy1`), so its wait, its on/off switch and
//     its words are all keyed separately from the original. Editing the
//     original afterwards does not rewrite the copy.
//   * It is anchored to the step before it. A copy sitting under its original
//     with the SAME `enrolled` anchor would be due at the same instant as the
//     original, and the min-gap floor would then just delay it — which reads
//     as "my duplicate goes out at a random time". `prevStep` makes the wait
//     mean the obvious thing: this long after the message above.

import type { SequenceDef, SequenceStep } from "../sequences/definitions.ts";

/** Separates a copy from the step it came from. Two underscores because a
 *  single one is legal inside a catalog key segment and this must never be
 *  ambiguous with a real step called `t2_copy1`. */
export const COPY_MARKER = "__copy";

export interface CustomStepRow {
  sequence_id: string;
  step_key: string;
  source_step_key: string;
  after_step_key: string;
}

/** The default wait a duplicate is created with. One day after the message it
 *  sits under — long enough not to read as a double-send, short enough that
 *  nobody has to change it before the funnel makes sense. */
export const DEFAULT_COPY_DAYS = 1;

/** `t2__copy1` → `t2`. Returns the key unchanged when it isn't a copy, so it
 *  is safe to call on anything. */
export function sourceOf(stepKey: string): string {
  const i = stepKey.indexOf(COPY_MARKER);
  return i === -1 ? stepKey : stepKey.slice(0, i);
}

export function isCopy(stepKey: string): boolean {
  return stepKey.includes(COPY_MARKER);
}

/** The next free copy key for a source step, given what already exists.
 *  Counts UP rather than reusing a freed number: `t2__copy2` may still own
 *  words and a wait in tables this function cannot see, and handing its key to
 *  a different duplicate would silently adopt them. */
export function nextCopyKey(sourceStepKey: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let n = 1; n <= 99; n++) {
    const key = `${sourceStepKey}${COPY_MARKER}${n}`;
    if (!taken.has(key)) return key;
  }
  throw new Error(`No free copy key for ${sourceStepKey}`);
}

/** Is this a duplicate the funnel can actually send? Rejects the rows that
 *  would produce a step the engine cannot render — a source that no longer
 *  exists (a touch removed in a later deploy), or an `after` that doesn't
 *  either. Invalid rows are DROPPED by applyCustomSteps rather than throwing:
 *  this runs inside the tick. */
export function isSendableCustomStep(def: SequenceDef, row: CustomStepRow): boolean {
  if (row.sequence_id !== def.id) return false;
  if (!isCopy(row.step_key)) return false;
  const source = def.steps.find((s) => s.key === row.source_step_key);
  if (!source) return false;
  // The copy sits after something. That something may itself be a copy, which
  // is why this is checked against the def as it stands when called.
  return def.steps.some((s) => s.key === row.after_step_key) || isCopy(row.after_step_key);
}

/**
 * `def` with every valid duplicate injected after the step it belongs to.
 *
 * Also raises the sequence's touch caps by the number of steps added. Without
 * that, duplicating the third touch of a funnel capped at three would create a
 * step, show it in the editor, give it a wait — and then have the cap silently
 * drop it, which is the exact failure mode this codebase keeps warning about.
 * The caps still bound a RUNAWAY (they are raised by the number of steps a
 * person deliberately added, not removed), and switching a duplicate off puts
 * its allowance back because it is no longer in `rows`.
 */
export function applyCustomSteps(def: SequenceDef, rows: readonly CustomStepRow[] | null | undefined): SequenceDef {
  const mine = (rows ?? []).filter((r) => r && r.sequence_id === def.id);
  if (mine.length === 0) return def;

  let steps = [...def.steps];
  let added = 0;

  // Several passes, because a copy can sit after another copy and the rows
  // arrive in no particular order. Each pass places whatever is now placeable;
  // it stops as soon as a pass places nothing, so an orphan row (its `after`
  // never appears) is dropped rather than looping.
  const pending = mine.filter((r) => isSendableCustomStep({ ...def, steps }, r));
  let remaining = pending;
  while (remaining.length > 0) {
    const stillPending: CustomStepRow[] = [];
    let placedThisPass = 0;

    for (const row of remaining) {
      if (steps.some((s) => s.key === row.step_key)) continue; // already placed
      const afterIndex = steps.findIndex((s) => s.key === row.after_step_key);
      const source = steps.find((s) => s.key === row.source_step_key);
      if (afterIndex === -1 || !source) {
        stillPending.push(row);
        continue;
      }
      const copy: SequenceStep = {
        ...source,
        key: row.step_key,
        // What its paragraphs and its voice come from. The send site renders
        // the SOURCE's shape under the COPY's keys.
        copyOf: row.source_step_key,
        anchor: "prevStep",
        days: DEFAULT_COPY_DAYS,
        // Email only. A duplicate's text twin would need its own number, its
        // own segment budget and its own opt-out, and none of that is implied
        // by "duplicate this email".
        channels: ["email"],
      };
      steps = [...steps.slice(0, afterIndex + 1), copy, ...steps.slice(afterIndex + 1)];
      added++;
      placedThisPass++;
    }

    if (placedThisPass === 0) break; // nothing left that can be placed
    remaining = stillPending;
  }

  if (added === 0) return def;

  return {
    ...def,
    steps,
    maxColdTouches: def.maxColdTouches + added,
    maxEmailTouches: def.maxEmailTouches + added,
  };
}

/** The rows a table read produced, ignoring anything malformed. Shared by the
 *  API and the tick so the page and the metronome cannot read the same table
 *  differently. */
export function parseCustomStepRows(
  rows: readonly Record<string, unknown>[] | null | undefined
): CustomStepRow[] {
  const out: CustomStepRow[] = [];
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    const { sequence_id, step_key, source_step_key, after_step_key } = row;
    if (
      typeof sequence_id !== "string" ||
      typeof step_key !== "string" ||
      typeof source_step_key !== "string" ||
      typeof after_step_key !== "string"
    ) continue;
    if (!isCopy(step_key)) continue;
    out.push({ sequence_id, step_key, source_step_key, after_step_key });
  }
  return out;
}

/** May this duplicate be moved to sit after `afterStepKey`?
 *
 *  Refuses the three arrangements that would produce a funnel the engine
 *  cannot lay out:
 *    - moving something that is not a duplicate (the built-in order is code);
 *    - dropping it on itself;
 *    - a cycle — copy A after copy B after copy A, which applyCustomSteps
 *      would place neither of, silently dropping both from the funnel.
 *
 *  Pure, so the API and a test can agree on what a legal move is. */
export function canMoveCustomStep(
  rows: readonly CustomStepRow[],
  sequenceId: string,
  stepKey: string,
  afterStepKey: string
): boolean {
  if (!isCopy(stepKey)) return false;
  if (stepKey === afterStepKey) return false;

  // Walk the chain the move would create. A built-in step ends the walk, and
  // that is the only legal ending.
  const after = new Map<string, string>();
  for (const r of rows) {
    if (r.sequence_id === sequenceId) after.set(r.step_key, r.after_step_key);
  }
  after.set(stepKey, afterStepKey);

  const seen = new Set<string>([stepKey]);
  let cursor: string | undefined = afterStepKey;
  while (cursor !== undefined && isCopy(cursor)) {
    if (seen.has(cursor)) return false; // back where we started
    seen.add(cursor);
    cursor = after.get(cursor);
  }
  return true;
}

/** The funnel as it actually runs: duplicates injected, then staff waits laid
 *  over the result. ORDER MATTERS — a duplicate's own wait is keyed on its own
 *  step key, so the copy has to exist before the waits are applied or its
 *  retime is dropped as "a step no funnel has". Every site that resolves a
 *  sequence goes through this, so the tick, the enrolment parker and the click
 *  re-anchor cannot each compose it slightly differently. */
export function resolveSequence(
  def: SequenceDef,
  config: { timing?: Record<string, number> | null; custom?: readonly CustomStepRow[] | null },
  applyTiming: (d: SequenceDef, t: Record<string, number> | null | undefined) => SequenceDef
): SequenceDef {
  return applyTiming(applyCustomSteps(def, config.custom), config.timing);
}
