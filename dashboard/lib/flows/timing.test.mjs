import test from "node:test";
import assert from "node:assert/strict";

import {
  applyStepTiming,
  isValidWaitDays,
  parseTimingRows,
  parseEnabledRows,
  timingKey,
  MAX_WAIT_DAYS,
} from "./timing.ts";
import { SEQUENCES } from "../sequences/definitions.ts";
import { nextDecision } from "../sequences/schedule.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysOf(def, key) {
  return def.steps.find((s) => s.key === key).days;
}

test("isValidWaitDays accepts the range the column stores", () => {
  assert.equal(isValidWaitDays(0), true);
  assert.equal(isValidWaitDays(0.5), true);
  assert.equal(isValidWaitDays(MAX_WAIT_DAYS), true);
});

test("isValidWaitDays rejects the values that would park a run forever", () => {
  // NaN is the dangerous one: `anchor + NaN * DAY_MS` is NaN, which is never
  // <= now, so the enrolment is never selected again and never errors either.
  assert.equal(isValidWaitDays(NaN), false);
  assert.equal(isValidWaitDays(Infinity), false);
  assert.equal(isValidWaitDays(-1), false);
  assert.equal(isValidWaitDays(MAX_WAIT_DAYS + 0.001), false);
  assert.equal(isValidWaitDays("3"), false);
  assert.equal(isValidWaitDays(null), false);
  assert.equal(isValidWaitDays(undefined), false);
});

test("applyStepTiming replaces only the overridden step", () => {
  const def = SEQUENCES.recruit_cold;
  const out = applyStepTiming(def, { [timingKey("recruit_cold", "t2")]: 1 });
  assert.equal(daysOf(out, "t2"), 1);
  assert.equal(daysOf(out, "t3"), daysOf(def, "t3"));
  assert.equal(daysOf(out, "t1"), daysOf(def, "t1"));
  // Shape is untouched: an override can change a wait, never the funnel.
  assert.deepEqual(out.steps.map((s) => s.key), def.steps.map((s) => s.key));
  assert.deepEqual(out.steps.map((s) => s.track), def.steps.map((s) => s.track));
  assert.deepEqual(out.steps.map((s) => s.anchor), def.steps.map((s) => s.anchor));
  assert.deepEqual(out.steps.map((s) => s.channels), def.steps.map((s) => s.channels));
});

test("applyStepTiming ignores an override for another sequence's step of the same name", () => {
  // Both recruit_cold and cold_offer_followup have step keys; keying on the
  // step alone would let a change to one funnel silently retime another.
  const def = SEQUENCES.cold_offer_followup;
  const out = applyStepTiming(def, { [timingKey("recruit_cold", "co1")]: 9 });
  assert.equal(daysOf(out, "co1"), daysOf(def, "co1"));
});

test("applyStepTiming is a no-op for no overrides, a null map, and a redundant one", () => {
  const def = SEQUENCES.recruit_cold;
  assert.equal(applyStepTiming(def, null), def);
  assert.equal(applyStepTiming(def, undefined), def);
  assert.equal(applyStepTiming(def, {}), def);
  // Writing back the value it already has changes nothing, so the object is
  // still the same one — a cheap proof that "no overrides" really is inert.
  assert.equal(applyStepTiming(def, { [timingKey("recruit_cold", "t3")]: daysOf(def, "t3") }), def);
});

test("applyStepTiming drops a bad row rather than stopping the funnel", () => {
  const def = SEQUENCES.recruit_cold;
  const out = applyStepTiming(def, {
    [timingKey("recruit_cold", "t2")]: NaN,
    [timingKey("recruit_cold", "t3")]: 999,
    [timingKey("recruit_cold", "r1")]: 1,
  });
  assert.equal(daysOf(out, "t2"), daysOf(def, "t2"), "NaN falls back to the code default");
  assert.equal(daysOf(out, "t3"), daysOf(def, "t3"), "out of range falls back to the code default");
  assert.equal(daysOf(out, "r1"), 1, "the good row still applies");
});

test("applyStepTiming does not mutate the shared SEQUENCES table", () => {
  const before = daysOf(SEQUENCES.recruit_cold, "t2");
  applyStepTiming(SEQUENCES.recruit_cold, { [timingKey("recruit_cold", "t2")]: 1 });
  assert.equal(daysOf(SEQUENCES.recruit_cold, "t2"), before);
});

test("parseTimingRows coerces the numeric Postgres sends as a string", () => {
  // PostgREST returns `numeric` as a string. Without the coercion the override
  // fails isValidWaitDays and is silently dropped — the exact failure mode of
  // "I changed it and nothing happened".
  const map = parseTimingRows([
    { sequence_id: "recruit_cold", step_key: "t2", days: "1.500" },
    { sequence_id: "recruit_cold", step_key: "t3", days: 4 },
  ]);
  assert.equal(map[timingKey("recruit_cold", "t2")], 1.5);
  assert.equal(map[timingKey("recruit_cold", "t3")], 4);
});

test("parseTimingRows skips malformed rows without throwing", () => {
  const map = parseTimingRows([
    { sequence_id: "recruit_cold", step_key: "t2", days: "not a number" },
    { sequence_id: 7, step_key: "t3", days: 1 },
    { sequence_id: "recruit_cold", days: 1 },
    null,
  ]);
  assert.deepEqual(map, {});
  assert.deepEqual(parseTimingRows(null), {});
  assert.deepEqual(parseTimingRows(undefined), {});
});

test("an overridden wait actually changes when the scheduler sends", () => {
  // The point of the whole feature: a number typed on /flows has to move the
  // metronome, not just the page.
  const created = "2026-09-01T09:00:00.000Z";
  const enrolment = {
    sequence_id: "recruit_cold",
    status: "active",
    track: "cold",
    step_index: 1,
    created_at: created,
    engaged_at: null,
    last_touch_at: created,
    touches_email: 1,
    touches_sms: 0,
  };
  const opts = { minGapHours: 0, hasPersona: true };
  const oneHourIn = Date.parse(created) + 60 * 60 * 1000;
  const twoDaysIn = Date.parse(created) + 2 * DAY_MS;

  // t2 ships 3.5 hours in, so an hour in there is nothing to send yet.
  const before = nextDecision(enrolment, SEQUENCES.recruit_cold, oneHourIn, opts);
  assert.equal(before.action, "wait");

  // Shorten it to zero and the same moment is now a send.
  const shortened = applyStepTiming(SEQUENCES.recruit_cold, { [timingKey("recruit_cold", "t2")]: 0 });
  const after = nextDecision(enrolment, shortened, oneHourIn, opts);
  assert.equal(after.action, "send");
  assert.equal(after.step.key, "t2");
});

// The override has to beat the step's OWN unit. t2 is declared in `hours`, and
// schedule.ts::stepOffsetMs reads `hours` in preference to `days` — so an
// override that set `days` without clearing `hours` would leave the funnel on
// its built-in wait while /flows displayed the new one. Silent, and only
// visible days later in the send log.
test("a day override beats a step declared in hours", () => {
  const created = "2026-09-01T09:00:00.000Z";
  const enrolment = {
    sequence_id: "recruit_cold",
    status: "active",
    track: "cold",
    step_index: 1,
    created_at: created,
    engaged_at: null,
    last_touch_at: created,
    touches_email: 1,
    touches_sms: 0,
  };
  const opts = { minGapHours: 0, hasPersona: true };

  // Stretch t2 from 3.5 hours out to two days.
  const stretched = applyStepTiming(SEQUENCES.recruit_cold, { [timingKey("recruit_cold", "t2")]: 2 });
  const t2 = stretched.steps.find((s) => s.key === "t2");
  assert.equal(t2.days, 2);
  assert.equal(t2.hours, undefined, "hours survived the override and would win over days");

  // Four hours in, the built-in wait would have fired; the override must not.
  const fourHoursIn = Date.parse(created) + 4 * 60 * 60 * 1000;
  assert.equal(nextDecision(enrolment, stretched, fourHoursIn, opts).action, "wait");

  const twoDaysIn = Date.parse(created) + 2 * DAY_MS;
  const due = nextDecision(enrolment, stretched, twoDaysIn, opts);
  assert.equal(due.action, "send");
  assert.equal(due.step.key, "t2");
});

test("parseEnabledRows lists only the steps that are switched off", () => {
  const map = parseEnabledRows([
    { sequence_id: "recruit_cold", step_key: "t2", days: null, enabled: false },
    { sequence_id: "recruit_cold", step_key: "t3", days: 4, enabled: true },
    { sequence_id: "recruit_cold", step_key: "r1", days: null, enabled: null },
  ]);
  // Only an explicit false counts. "enabled: true" and a missing/odd value are
  // both just "on", so they never need an entry.
  assert.deepEqual(map, { [timingKey("recruit_cold", "t2")]: false });
});

test("parseEnabledRows never silences a step on a malformed value", () => {
  const map = parseEnabledRows([
    { sequence_id: "recruit_cold", step_key: "t2", enabled: "false" },
    { sequence_id: "recruit_cold", step_key: "t3", enabled: 0 },
    { sequence_id: "recruit_cold", step_key: "r1" },
    null,
  ]);
  assert.deepEqual(map, {}, "a bad value must leave the step sending");
});

test("a row that exists only to switch a step off reports no wait override", () => {
  // `days` is nullable now: a row can be there purely to hold `enabled=false`.
  // Reading null as 0 would turn a switched-off step into an immediate one the
  // moment it came back on.
  const rows = [{ sequence_id: "recruit_cold", step_key: "t2", days: null, enabled: false }];
  assert.deepEqual(parseTimingRows(rows), {});
  assert.deepEqual(parseEnabledRows(rows), { [timingKey("recruit_cold", "t2")]: false });
});

test("a switched-off step is SKIPPED, and the run reaches the next one", () => {
  const created = "2026-09-01T09:00:00.000Z";
  const enrolment = {
    sequence_id: "recruit_cold",
    status: "active",
    track: "cold",
    step_index: 1,
    created_at: created,
    engaged_at: null,
    last_touch_at: created,
    touches_email: 1,
    touches_sms: 0,
  };
  const opts = { minGapHours: 0, hasPersona: true };
  // Day 8: both t2 (day 3) and t3 (day 7) are due; t2 is next in line.
  const at = Date.parse(created) + 8 * DAY_MS;

  const on = nextDecision(enrolment, SEQUENCES.recruit_cold, at, opts);
  assert.equal(on.action, "send");
  assert.equal(on.step.key, "t2");

  // Switch t2 off and the SAME moment sends t3 instead — the run moves on
  // rather than stalling on the step nobody wants sent.
  const off = nextDecision(enrolment, SEQUENCES.recruit_cold, at, {
    ...opts,
    disabledSteps: new Set([timingKey("recruit_cold", "t2")]),
  });
  assert.equal(off.action, "send");
  assert.equal(off.step.key, "t3");
});

test("switching off every remaining step ends the run instead of hanging", () => {
  const created = "2026-09-01T09:00:00.000Z";
  const enrolment = {
    sequence_id: "cold_offer_followup",
    status: "active",
    track: "cold",
    step_index: 0,
    created_at: created,
    engaged_at: null,
    last_touch_at: created,
    touches_email: 0,
    touches_sms: 0,
  };
  const decision = nextDecision(enrolment, SEQUENCES.cold_offer_followup, Date.parse(created) + 30 * DAY_MS, {
    minGapHours: 0,
    hasPersona: true,
    disabledSteps: new Set([
      timingKey("cold_offer_followup", "co1"),
      timingKey("cold_offer_followup", "co2"),
    ]),
  });
  assert.equal(decision.action, "stop");
  assert.equal(decision.reason, "exhausted");
});

test("switching off one funnel's step cannot silence another funnel's same-named step", () => {
  // recruit_cold has no `co1`, but the key is sequence-scoped precisely so a
  // future collision cannot cross funnels. Assert the scoping directly.
  const created = "2026-09-01T09:00:00.000Z";
  const enrolment = {
    sequence_id: "cold_offer_followup",
    status: "active",
    track: "cold",
    step_index: 0,
    created_at: created,
    engaged_at: null,
    last_touch_at: created,
    touches_email: 0,
    touches_sms: 0,
  };
  const decision = nextDecision(enrolment, SEQUENCES.cold_offer_followup, Date.parse(created) + 30 * DAY_MS, {
    minGapHours: 0,
    hasPersona: true,
    // A bare step key, and the wrong sequence's key. Neither may match.
    disabledSteps: new Set(["co1", timingKey("recruit_cold", "co1")]),
  });
  assert.equal(decision.action, "send");
  assert.equal(decision.step.key, "co1");
});
