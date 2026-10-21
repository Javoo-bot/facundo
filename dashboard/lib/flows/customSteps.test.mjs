import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCustomSteps,
  isSendableCustomStep,
  nextCopyKey,
  parseCustomStepRows,
  sourceOf,
  isCopy,
  DEFAULT_COPY_DAYS,
  COPY_MARKER,
  canMoveCustomStep,
} from "./customSteps.ts";
import { withCustomSteps, FLOWS } from "./catalog.ts";
import { SEQUENCES } from "../sequences/definitions.ts";
import { nextDecision } from "../sequences/schedule.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function row(over = {}) {
  return {
    sequence_id: "recruit_cold",
    step_key: "t2__copy1",
    source_step_key: "t2",
    after_step_key: "t2",
    ...over,
  };
}

test("sourceOf and isCopy round-trip the marker", () => {
  assert.equal(sourceOf("t2__copy1"), "t2");
  assert.equal(sourceOf("t2__copy12"), "t2");
  assert.equal(sourceOf("t2"), "t2");
  assert.equal(isCopy("t2"), false);
  assert.equal(isCopy("t2__copy1"), true);
  // A single underscore is legal in a real step key and must not read as a copy.
  assert.equal(isCopy("t2_copy1"), false);
  assert.equal(sourceOf("t2_copy1"), "t2_copy1");
});

test("nextCopyKey counts up and never reuses a freed number", () => {
  assert.equal(nextCopyKey("t2", []), `t2${COPY_MARKER}1`);
  assert.equal(nextCopyKey("t2", ["t2__copy1"]), "t2__copy2");
  // copy1 deleted, copy2 still alive: the next one must not become copy1,
  // which would silently adopt whatever words copy1 left behind.
  assert.equal(nextCopyKey("t2", ["t2__copy2"]), "t2__copy1");
  assert.equal(nextCopyKey("t2", ["t2__copy1", "t2__copy2"]), "t2__copy3");
  // Another step's copies don't consume this one's numbers.
  assert.equal(nextCopyKey("t3", ["t2__copy1"]), "t3__copy1");
});

test("a copy is placed under its source, with its own key", () => {
  const def = applyCustomSteps(SEQUENCES.recruit_cold, [row()]);
  const keys = def.steps.map((s) => s.key);
  assert.deepEqual(keys, ["t1", "t2", "t2__copy1", "t3", "r1", "r2"]);

  const copy = def.steps.find((s) => s.key === "t2__copy1");
  assert.equal(copy.copyOf, "t2", "renders the shape of the step it copied");
  assert.equal(copy.anchor, "prevStep", "counted from the message above it");
  assert.equal(copy.days, DEFAULT_COPY_DAYS);
  assert.deepEqual(copy.channels, ["email"]);
  // Everything else is inherited, so a copy of a persona-signed touch is also
  // persona-signed and cannot arrive unsigned.
  const source = SEQUENCES.recruit_cold.steps.find((s) => s.key === "t2");
  assert.equal(copy.track, source.track);
  assert.equal(copy.from, source.from);
  assert.equal(copy.voice, source.voice);
});

test("adding a copy raises the caps, so it is not created and then capped", () => {
  const base = SEQUENCES.recruit_cold;
  const one = applyCustomSteps(base, [row()]);
  assert.equal(one.maxColdTouches, base.maxColdTouches + 1);
  assert.equal(one.maxEmailTouches, base.maxEmailTouches + 1);

  const two = applyCustomSteps(base, [row(), row({ step_key: "t3__copy1", source_step_key: "t3", after_step_key: "t3" })]);
  assert.equal(two.maxColdTouches, base.maxColdTouches + 2);
});

test("a copy of a copy stacks in order, whatever order the rows arrive in", () => {
  const rows = [
    row({ step_key: "t2__copy2", after_step_key: "t2__copy1" }),
    row({ step_key: "t2__copy1", after_step_key: "t2" }),
  ];
  const def = applyCustomSteps(SEQUENCES.recruit_cold, rows);
  assert.deepEqual(def.steps.map((s) => s.key), ["t1", "t2", "t2__copy1", "t2__copy2", "t3", "r1", "r2"]);
});

test("rows the engine could not send are dropped, not thrown", () => {
  const base = SEQUENCES.recruit_cold;
  // A source that no longer exists (a touch removed in a later deploy).
  assert.equal(applyCustomSteps(base, [row({ source_step_key: "gone" })]), base);
  // Another sequence's row.
  assert.equal(applyCustomSteps(base, [row({ sequence_id: "cold_offer_followup" })]), base);
  // An `after` that never appears — an orphan, dropped without looping.
  const orphan = applyCustomSteps(base, [row({ after_step_key: "nowhere" })]);
  assert.deepEqual(orphan.steps.map((s) => s.key), base.steps.map((s) => s.key));
  // A key that isn't a copy at all.
  assert.equal(applyCustomSteps(base, [row({ step_key: "t9" })]), base);
});

test("applyCustomSteps is a no-op for no rows and does not mutate SEQUENCES", () => {
  const base = SEQUENCES.recruit_cold;
  assert.equal(applyCustomSteps(base, []), base);
  assert.equal(applyCustomSteps(base, null), base);
  assert.equal(applyCustomSteps(base, undefined), base);
  const before = base.steps.length;
  applyCustomSteps(base, [row()]);
  assert.equal(SEQUENCES.recruit_cold.steps.length, before);
});

test("isSendableCustomStep refuses what applyCustomSteps drops", () => {
  const def = SEQUENCES.recruit_cold;
  assert.equal(isSendableCustomStep(def, row()), true);
  assert.equal(isSendableCustomStep(def, row({ source_step_key: "gone" })), false);
  assert.equal(isSendableCustomStep(def, row({ sequence_id: "cold" })), false);
  assert.equal(isSendableCustomStep(def, row({ step_key: "t2" })), false);
});

test("parseCustomStepRows skips malformed rows without throwing", () => {
  assert.deepEqual(parseCustomStepRows(null), []);
  assert.deepEqual(parseCustomStepRows([null, {}, { sequence_id: 1 }]), []);
  // Not a copy key: refused, so a hand-written row cannot shadow a real step.
  assert.deepEqual(parseCustomStepRows([row({ step_key: "t2" })]), []);
  assert.equal(parseCustomStepRows([row()]).length, 1);
});

test("a duplicate actually sends: the scheduler picks it after its source", () => {
  // The whole point. A copy that appears in the editor and never goes out
  // would be the exact "field that silently does nothing" this codebase warns
  // about, so this asserts the metronome reaches it.
  const def = applyCustomSteps(SEQUENCES.recruit_cold, [row()]);
  const created = "2026-09-01T09:00:00.000Z";
  // t1 and t2 already sent; the copy is next, one day after t2 went out.
  const enrolment = {
    sequence_id: "recruit_cold",
    status: "active",
    track: "cold",
    step_index: 2,
    created_at: created,
    engaged_at: null,
    last_touch_at: "2026-09-04T09:00:00.000Z",
    touches_email: 2,
    touches_sms: 0,
  };
  const opts = { minGapHours: 0, hasPersona: true };

  const tooEarly = nextDecision(enrolment, def, Date.parse(enrolment.last_touch_at) + 2 * 3600_000, opts);
  assert.equal(tooEarly.action, "wait");

  const due = nextDecision(enrolment, def, Date.parse(enrolment.last_touch_at) + DAY_MS, opts);
  assert.equal(due.action, "send");
  assert.equal(due.step.key, "t2__copy1");
  assert.equal(due.step.copyOf, "t2");
});

test("switching a copy off skips it and the funnel carries on", () => {
  const def = applyCustomSteps(SEQUENCES.recruit_cold, [row()]);
  const enrolment = {
    sequence_id: "recruit_cold",
    status: "active",
    track: "cold",
    step_index: 2,
    created_at: "2026-09-01T09:00:00.000Z",
    last_touch_at: "2026-09-04T09:00:00.000Z",
    engaged_at: null,
    touches_email: 2,
    touches_sms: 0,
  };
  const at = Date.parse("2026-09-30T09:00:00.000Z"); // everything is due by now
  const decision = nextDecision(enrolment, def, at, {
    minGapHours: 0,
    hasPersona: true,
    disabledSteps: new Set(["recruit_cold:t2__copy1"]),
  });
  assert.equal(decision.action, "send");
  assert.equal(decision.step.key, "t3", "skipped the copy, did not stall on it");
});

test("the page's step list and the engine's agree on which steps exist, in order", () => {
  // Two functions build two shapes over the same rows — withCustomSteps for
  // the page, applyCustomSteps for the scheduler. If they ever disagree, the
  // page shows a funnel that is not the one being sent.
  const rows = [
    { sequence_id: "recruit_cold", step_key: "t2__copy1", source_step_key: "t2", after_step_key: "t2" },
    { sequence_id: "recruit_cold", step_key: "t3__copy1", source_step_key: "t3", after_step_key: "t3" },
    { sequence_id: "cold_offer_followup", step_key: "co1__copy1", source_step_key: "co1", after_step_key: "co1" },
  ];

  for (const flow of FLOWS) {
    const shown = withCustomSteps(flow, rows).steps.filter((s) => s.timing);
    // Group the page's rows by the sequence they belong to, and compare with
    // what the engine would run for that sequence.
    const bySeq = {};
    for (const s of shown) (bySeq[s.timing.sequenceId] ??= []).push(s.timing.stepKey);
    for (const [seqId, keys] of Object.entries(bySeq)) {
      const engine = applyCustomSteps(SEQUENCES[seqId], rows)
        .steps.filter((s) => keys.includes(s.key) || isCopy(s.key))
        .map((s) => s.key)
        .filter((k) => keys.includes(k));
      assert.deepEqual(keys, engine, `${flow.id}/${seqId} order drifted`);
    }
  }
});

test("withCustomSteps gives a copy its own message, wait and label", () => {
  const cold = FLOWS.find((f) => f.id === "cold");
  const shown = withCustomSteps(cold, [
    { sequence_id: "recruit_cold", step_key: "t2__copy1", source_step_key: "t2", after_step_key: "t2" },
  ]);
  const copy = shown.steps.find((s) => s.timing?.stepKey === "t2__copy1");
  assert.ok(copy, "the copy is listed");
  assert.deepEqual(copy.messageIds, ["recruit.t2__copy1"], "its own message, not the original's");
  assert.equal(copy.anchor, "prevStep");
  assert.deepEqual(copy.channels, ["email"]);
  // Placed directly under its source.
  const keys = shown.steps.map((s) => s.timing?.stepKey ?? s.id);
  assert.equal(keys[keys.indexOf("t2") + 1], "t2__copy1");
  // Row ids stay unique — they are React keys.
  const ids = shown.steps.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("withCustomSteps leaves a funnel with no duplicates untouched", () => {
  for (const flow of FLOWS) {
    assert.equal(withCustomSteps(flow, []), flow);
  }
});

test("a duplicate can be moved, but not into an arrangement that cannot be laid out", () => {
  const rows = [
    { sequence_id: "recruit_cold", step_key: "t2__copy1", source_step_key: "t2", after_step_key: "t2" },
    { sequence_id: "recruit_cold", step_key: "t3__copy1", source_step_key: "t3", after_step_key: "t3" },
  ];
  // Ordinary moves: onto a built-in step, or after another copy.
  assert.equal(canMoveCustomStep(rows, "recruit_cold", "t2__copy1", "r1"), true);
  assert.equal(canMoveCustomStep(rows, "recruit_cold", "t2__copy1", "t3__copy1"), true);

  // Only a duplicate moves — the built-in order is code.
  assert.equal(canMoveCustomStep(rows, "recruit_cold", "t2", "t3"), false);
  // Onto itself.
  assert.equal(canMoveCustomStep(rows, "recruit_cold", "t2__copy1", "t2__copy1"), false);

  // A cycle. applyCustomSteps would place neither, silently dropping both
  // copies out of the funnel — so the move is refused rather than accepted
  // and then quietly undone by the engine.
  const chained = [
    { sequence_id: "recruit_cold", step_key: "t2__copy1", source_step_key: "t2", after_step_key: "t2" },
    { sequence_id: "recruit_cold", step_key: "t2__copy2", source_step_key: "t2", after_step_key: "t2__copy1" },
  ];
  assert.equal(canMoveCustomStep(chained, "recruit_cold", "t2__copy1", "t2__copy2"), false);
});

test("a moved duplicate lands where it was dropped", () => {
  const moved = [{ sequence_id: "recruit_cold", step_key: "t2__copy1", source_step_key: "t2", after_step_key: "r1" }];
  const def = applyCustomSteps(SEQUENCES.recruit_cold, moved);
  assert.deepEqual(def.steps.map((s) => s.key), ["t1", "t2", "t3", "r1", "t2__copy1", "r2"]);
  // Still renders the shape it copied, wherever it sits.
  assert.equal(def.steps.find((s) => s.key === "t2__copy1").copyOf, "t2");
});
