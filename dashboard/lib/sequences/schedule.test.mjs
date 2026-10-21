import test from "node:test";
import assert from "node:assert/strict";
import { nextDecision, applyEngagement, dueAt, allowedStepChannels, trackSteps } from "./schedule.ts";
import { SEQUENCES, sequenceDef, stepKind } from "./definitions.ts";

const RECRUIT = sequenceDef("recruit_cold");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-08-01T09:00:00.000Z");

// The same-day funnel's offsets, named so a change to the schedule breaks these
// tests in one obvious place rather than as a scatter of magic numbers.
const T2_AFTER_ENROL = 3.5 * HOUR;
const T3_AFTER_ENROL = 8 * HOUR;
const R1_AFTER_CLICK = 45 * 60 * 1000;
const R2_AFTER_R1 = 4 * HOUR;

const enrol = (over = {}) => ({
  sequence_id: "recruit_cold",
  status: "active",
  track: "cold",
  step_index: 0,
  created_at: new Date(T0).toISOString(),
  engaged_at: null,
  last_touch_at: null,
  touches_email: 0,
  touches_sms: 0,
  ...over,
});

// A florist who has had the day-0 email and nothing since.
const afterT1 = (over = {}) =>
  enrol({ step_index: 1, touches_email: 1, last_touch_at: new Date(T0).toISOString(), ...over });

// ---- the cold track: same day, 0h / 3.5h / 8h ----
//
// No openState is passed, so it defaults to `unknown` — which satisfies both
// gates. That default IS the contract: a caller that cannot resolve open state
// must get the whole funnel, not a muted one.

test("the cold track fires at 0h, 3.5h and 8h", () => {
  const t1 = nextDecision(enrol(), RECRUIT, T0);
  assert.equal(t1.action, "send");
  assert.equal(t1.step.key, "t1");

  const t2 = nextDecision(afterT1(), RECRUIT, T0 + T2_AFTER_ENROL);
  assert.equal(t2.action, "send");
  assert.equal(t2.step.key, "t2");

  const t3 = nextDecision(
    afterT1({ step_index: 2, touches_email: 2, last_touch_at: new Date(T0 + T2_AFTER_ENROL).toISOString() }),
    RECRUIT,
    T0 + T3_AFTER_ENROL
  );
  assert.equal(t3.action, "send");
  assert.equal(t3.step.key, "t3");
});

test("the whole cold track resolves inside one day", () => {
  for (const step of RECRUIT.steps.filter((s) => s.track === "cold")) {
    const offset = typeof step.hours === "number" ? step.hours : (step.days ?? 0) * 24;
    assert.ok(offset <= 24, `${step.key} is ${offset}h after enrolment — outside the one-day promise`);
  }
});

test("a step that isn't due yet waits, and says until when", () => {
  const d = nextDecision(afterT1(), RECRUIT, T0 + 1 * HOUR);
  assert.equal(d.action, "wait");
  assert.equal(d.until, new Date(T0 + T2_AFTER_ENROL).toISOString());
});

test("t2 is not due one millisecond early", () => {
  assert.equal(nextDecision(afterT1(), RECRUIT, T0 + T2_AFTER_ENROL - 1).action, "wait");
  assert.equal(nextDecision(afterT1(), RECRUIT, T0 + T2_AFTER_ENROL).action, "send");
});

// the marketing lead's rule: max 3 touches for a prospect who never engages.
test("a never-engaged prospect gets exactly three touches, then stops", () => {
  const spent = enrol({ step_index: 3, touches_email: 3, last_touch_at: new Date(T0 + 7 * DAY).toISOString() });
  const d = nextDecision(spent, RECRUIT, T0 + 30 * DAY);
  assert.equal(d.action, "stop");
});

test("the cold cap counts messages, not emails — a text spends one too", () => {
  // t1 sent on both channels (2) + t2 (1) = 3 touches. No fourth.
  const spent = enrol({
    step_index: 2,
    touches_email: 2,
    touches_sms: 1,
    last_touch_at: new Date(T0 + 3 * DAY).toISOString(),
  });
  const d = nextDecision(spent, RECRUIT, T0 + 7 * DAY);
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "cap_cold");
});

// ---- the click branch ----

test("a first click switches track, resets the step index and re-anchors the clock", () => {
  const clickedAt = new Date(T0 + 1 * DAY).toISOString();
  const e = applyEngagement(afterT1(), clickedAt);
  assert.equal(e.track, "reengage");
  assert.equal(e.step_index, 0);
  assert.equal(e.engaged_at, clickedAt);
});

test("re-engagement 1 fires 45 minutes after the click, on email AND sms", () => {
  const clickedAt = T0 + 1 * DAY;
  const e = applyEngagement(afterT1(), new Date(clickedAt).toISOString());

  assert.equal(nextDecision(e, RECRUIT, clickedAt + R1_AFTER_CLICK - 1).action, "wait");

  const d = nextDecision(e, RECRUIT, clickedAt + R1_AFTER_CLICK);
  assert.equal(d.action, "send");
  assert.equal(d.step.key, "r1");
  assert.deepEqual(d.channels.slice().sort(), ["email", "sms"]);
});

// The clock belongs to their action, not ours: clicking late must not mean
// waiting longer.
test("the re-engagement clock anchors to the click, whenever it lands", () => {
  for (const clickDay of [0, 1, 5, 6.9]) {
    const clickedAt = T0 + clickDay * DAY;
    const e = applyEngagement(afterT1(), new Date(clickedAt).toISOString());
    const d = nextDecision(e, RECRUIT, clickedAt + R1_AFTER_CLICK);
    assert.equal(d.action, "send", `click on day ${clickDay}`);
    assert.equal(d.step.key, "r1");
  }
});

test("re-engagement 2 fires four hours after re-engagement 1, email only", () => {
  const clickedAt = T0 + 1 * DAY;
  const r1At = clickedAt + R1_AFTER_CLICK;
  const e = applyEngagement(afterT1(), new Date(clickedAt).toISOString());
  const afterR1 = { ...e, step_index: 1, touches_email: 2, touches_sms: 1, last_touch_at: new Date(r1At).toISOString() };

  assert.equal(nextDecision(afterR1, RECRUIT, r1At + R2_AFTER_R1 - 1).action, "wait");

  const d = nextDecision(afterR1, RECRUIT, r1At + R2_AFTER_R1);
  assert.equal(d.action, "send");
  assert.equal(d.step.key, "r2");
  assert.deepEqual(d.channels, ["email"]);
});

// A link scanner clicks every URL in an email, sometimes twice. If a second
// click re-anchored the clock, the funnel would never advance.
test("a second click is a no-op", () => {
  const first = new Date(T0 + 1 * DAY).toISOString();
  const e = applyEngagement(afterT1(), first);
  const again = applyEngagement({ ...e, step_index: 1 }, new Date(T0 + 2 * DAY).toISOString());
  assert.equal(again.engaged_at, first);
  assert.equal(again.step_index, 1, "a repeat click rewound the run");
});

test("engagement on a stopped enrolment changes nothing", () => {
  const dead = enrol({ status: "stopped" });
  assert.deepEqual(applyEngagement(dead, new Date(T0).toISOString()), dead);
});

// ---- caps for an engaged prospect: 4 email + 1 sms beyond the first ----

test("an engaged prospect is capped at four emails across both tracks", () => {
  const e = applyEngagement(afterT1(), new Date(T0 + 1 * DAY).toISOString());
  const capped = { ...e, step_index: 1, touches_email: 4, last_touch_at: new Date(T0 + 3 * DAY).toISOString() };
  const d = nextDecision(capped, RECRUIT, T0 + 30 * DAY);
  assert.equal(d.action, "stop");
});

test("an sms-capped step still sends its email leg", () => {
  const e = applyEngagement(afterT1({ touches_sms: 2 }), new Date(T0 + 1 * DAY).toISOString());
  const d = nextDecision(e, RECRUIT, T0 + 1 * DAY + R1_AFTER_CLICK);
  assert.equal(d.action, "send");
  assert.equal(d.step.key, "r1");
  assert.deepEqual(d.channels, ["email"], "kept texting past the SMS cap");
});

// ---- persona and the frequency floor ----

test("a persona-signed step is skipped when the market has no persona", () => {
  // t2/t3 are persona-signed; with none configured the run must not send an
  // unsigned 'personal' email — it stops instead.
  const d = nextDecision(afterT1(), RECRUIT, T0 + 30 * DAY, { hasPersona: false });
  assert.equal(d.action, "stop");
});

test("the min-gap floor delays a touch, it never drops it", () => {
  // t1 went out 30 minutes ago; t2 is due now but the floor is an hour.
  const e = afterT1({ last_touch_at: new Date(T0 + T2_AFTER_ENROL - 30 * 60 * 1000).toISOString() });
  const d = nextDecision(e, RECRUIT, T0 + T2_AFTER_ENROL, { minGapHours: 1 });
  assert.equal(d.action, "wait");
  assert.ok(Date.parse(d.until) > T0 + T2_AFTER_ENROL, "gap floor did not push the touch out");
});

// The floor is measured against the SAME-DAY funnel now. At the historical
// default of 48h every follow-up is deferred past its own step and the funnel
// silently degrades to a single email — the failure this asserts against.
test("a 48-hour min gap would suppress the same-day follow-ups", () => {
  const e = afterT1({ last_touch_at: new Date(T0).toISOString() });
  const d = nextDecision(e, RECRUIT, T0 + T2_AFTER_ENROL, { minGapHours: 48 });
  assert.equal(d.action, "wait", "t2 was sent despite a 48h floor");
  assert.ok(
    Date.parse(d.until) >= T0 + 48 * 60 * 60 * 1000,
    "the 48h floor did not push t2 a full two days out"
  );
});

// ---- status and lifecycle ----

test("a paused enrolment is never advanced by the scheduler", () => {
  // Resuming is enrol.ts's job. If the scheduler could un-pause, an order offer
  // and a recruiting email could go out in the same minute.
  const d = nextDecision(afterT1({ status: "paused" }), RECRUIT, T0 + 30 * DAY);
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "not_active");
});

test("running out of steps stops with 'exhausted', not an error", () => {
  const done = enrol({ track: "reengage", step_index: 2, engaged_at: new Date(T0).toISOString(), touches_email: 3 });
  const d = nextDecision(done, RECRUIT, T0 + 30 * DAY);
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "exhausted");
});

// ---- the cold-offer follow-up ----

test("the cold-offer follow-up runs on a short horizon and never texts", () => {
  const def = sequenceDef("cold_offer_followup");
  const e = enrol({ sequence_id: "cold_offer_followup" });
  const d = nextDecision(e, def, T0 + 12 * 60 * 60 * 1000);
  assert.equal(d.action, "send");
  assert.equal(d.step.key, "co1");
  assert.deepEqual(d.channels, ["email"]);
  assert.equal(def.maxSmsTouches, 0);
});

// ---- structural invariants ----

test("every step's kind matches its copy namespace", () => {
  for (const def of Object.values(SEQUENCES)) {
    for (const step of def.steps) {
      assert.equal(stepKind(step), `${step.ns ?? "recruit"}.${step.key}`);
    }
  }
});

// A network sequence run against a shop that never joined is nonsense, and a
// prospect sequence ends the moment they do — the tick reads `audience` to pick
// which rule applies, so a missing one would silently get the recruiting rule
// and kill every reactivation run on its first tick.
test("every sequence declares who it is for", () => {
  for (const def of Object.values(SEQUENCES)) {
    assert.ok(["prospect", "network"].includes(def.audience), `${def.id} has no valid audience`);
  }
});

// Reactivation is aimed at partners, not strangers: an unexpected text to
// someone we already work with spends goodwill, and SMS is reserved for real
// orders, which is what they actually want to hear about.
test("network sequences never text", () => {
  for (const def of Object.values(SEQUENCES)) {
    if (def.audience !== "network") continue;
    assert.equal(def.maxSmsTouches, 0, `${def.id} allows SMS`);
    for (const step of def.steps) {
      assert.ok(!step.channels.includes("sms"), `${def.id}/${step.key} declares an SMS channel`);
    }
  }
});

test("no sequence declares a persona step it could sign before day 0", () => {
  for (const def of Object.values(SEQUENCES)) {
    for (const step of def.steps) {
      const offset = typeof step.hours === "number" ? step.hours : (step.days ?? 0);
      assert.ok(offset >= 0, `${def.id}/${step.key} has a negative offset`);
      assert.ok(step.channels.length > 0, `${def.id}/${step.key} has no channels`);
    }
  }
});

test("step keys are unique within a sequence", () => {
  for (const def of Object.values(SEQUENCES)) {
    const keys = def.steps.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, `${def.id} repeats a step key`);
  }
});

test("dueAt returns null when the anchor hasn't happened", () => {
  const r1 = trackSteps(RECRUIT, "reengage")[0];
  assert.equal(dueAt(r1, enrol()), null, "anchored to a click that never happened");
});

test("allowedStepChannels drops only the capped leg", () => {
  const step = { key: "x", track: "cold", anchor: "enrolled", days: 0, channels: ["email", "sms"], from: "company" };
  assert.deepEqual(allowedStepChannels(step, enrol({ touches_sms: 2 }), RECRUIT), ["email"]);
  assert.deepEqual(allowedStepChannels(step, enrol({ touches_email: 4 }), RECRUIT), ["sms"]);
  assert.deepEqual(allowedStepChannels(step, enrol({ touches_email: 4, touches_sms: 2 }), RECRUIT), []);
});

// ---- the open gate ----
//
// t2 and t3 are ALTERNATIVES, not a sequence: a shop that opened skips t2 and
// lands on t3; one that did not takes t2 and skips t3. That is why a failed
// gate SKIPS the step and walks on, rather than stopping the run — stopping
// would end an opener's funnel at t2, which is most of the funnel.

test("a shop that opened skips t2 and receives t3", () => {
  const e = afterT1();
  const atT2 = nextDecision(e, RECRUIT, T0 + T2_AFTER_ENROL, { openState: "opened" });
  assert.equal(atT2.action, "wait", "t2 went to someone who had already opened");
  assert.equal(atT2.until, new Date(T0 + T3_AFTER_ENROL).toISOString(), "did not walk on to t3");

  const atT3 = nextDecision(e, RECRUIT, T0 + T3_AFTER_ENROL, { openState: "opened" });
  assert.equal(atT3.action, "send");
  assert.equal(atT3.step.key, "t3");
});

test("a shop that did not open receives t2 and skips t3", () => {
  const e = afterT1();
  const atT2 = nextDecision(e, RECRUIT, T0 + T2_AFTER_ENROL, { openState: "not_opened" });
  assert.equal(atT2.action, "send");
  assert.equal(atT2.step.key, "t2");

  const afterT2 = afterT1({ step_index: 2, touches_email: 2, last_touch_at: new Date(T0 + T2_AFTER_ENROL).toISOString() });
  const atT3 = nextDecision(afterT2, RECRUIT, T0 + T3_AFTER_ENROL, { openState: "not_opened" });
  assert.equal(atT3.action, "stop", "t3 went to someone who never opened anything");
  assert.equal(atT3.reason, "exhausted");
});

// The no-regression guarantee, and the reason OpenState has three values.
test("with NO provider feedback both follow-ups still send", () => {
  const e = afterT1();
  const t2 = nextDecision(e, RECRUIT, T0 + T2_AFTER_ENROL, { openState: "unknown" });
  assert.equal(t2.action, "send");
  assert.equal(t2.step.key, "t2");

  const afterT2 = afterT1({ step_index: 2, touches_email: 2, last_touch_at: new Date(T0 + T2_AFTER_ENROL).toISOString() });
  const t3 = nextDecision(afterT2, RECRUIT, T0 + T3_AFTER_ENROL, { openState: "unknown" });
  assert.equal(t3.action, "send");
  assert.equal(t3.step.key, "t3");
});

test("omitting openState behaves exactly like `unknown`", () => {
  // A caller that cannot resolve open state must get the whole funnel, not a
  // silently muted one.
  const e = afterT1();
  const withOut = nextDecision(e, RECRUIT, T0 + T2_AFTER_ENROL, {});
  const withUnknown = nextDecision(e, RECRUIT, T0 + T2_AFTER_ENROL, { openState: "unknown" });
  assert.deepEqual(withOut.step?.key, withUnknown.step?.key);
  assert.equal(withOut.action, withUnknown.action);
});

test("the open gate never blocks the click branch", () => {
  // r1/r2 carry no gate: a click already proves the message was seen, so a
  // dropped `opened` webhook must not mute the branch that matters most.
  const clickedAt = T0 + 1 * HOUR;
  const e = applyEngagement(afterT1(), new Date(clickedAt).toISOString());
  for (const openState of ["opened", "not_opened", "unknown"]) {
    const d = nextDecision(e, RECRUIT, clickedAt + R1_AFTER_CLICK, { openState });
    assert.equal(d.action, "send", `r1 blocked when openState=${openState}`);
    assert.equal(d.step.key, "r1");
  }
});

// ---- the send window ----

test("a touch due in the small hours waits for business hours", () => {
  // 02:00 Madrid. Without the window this shop is judged a non-opener at 05:30,
  // which measures what time we enrolled it rather than whether it is interested.
  const twoAm = Date.parse("2026-08-03T00:00:00.000Z");
  const e = afterT1({ created_at: new Date(twoAm - T2_AFTER_ENROL).toISOString(), last_touch_at: new Date(twoAm - T2_AFTER_ENROL).toISOString() });
  const d = nextDecision(e, RECRUIT, twoAm, { sendWindow: {} });
  assert.equal(d.action, "wait");
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d.until));
  assert.equal(hm, "09:00");
});

test("with no sendWindow the scheduler sends at any hour, as it always did", () => {
  const twoAm = Date.parse("2026-08-03T00:00:00.000Z");
  const e = afterT1({ created_at: new Date(twoAm - T2_AFTER_ENROL).toISOString(), last_touch_at: new Date(twoAm - T2_AFTER_ENROL).toISOString() });
  const d = nextDecision(e, RECRUIT, twoAm, {});
  assert.equal(d.action, "send");
  assert.equal(d.step.key, "t2");
});

test("a touch due inside the window is not delayed at all", () => {
  const elevenAm = Date.parse("2026-08-03T09:00:00.000Z"); // 11:00 Madrid
  const e = afterT1({ created_at: new Date(elevenAm - T2_AFTER_ENROL).toISOString(), last_touch_at: new Date(elevenAm - T2_AFTER_ENROL).toISOString() });
  const d = nextDecision(e, RECRUIT, elevenAm, { sendWindow: {} });
  assert.equal(d.action, "send");
  assert.equal(d.step.key, "t2");
});

// ---- the sent step's INDEX ----
//
// Observed on staging 2026-09-09: five shops received t2 TWICE. The tick was
// advancing `step_index` by one, but nextDecision had walked PAST several steps
// to reach the one it sent — so the next tick came back to a step already sent
// and sent it again. Any skip makes the two numbers differ, and the same-day
// funnel skips by design: that is what an open gate IS.

test("a send reports where in the track it actually landed", () => {
  const d = nextDecision(enrol(), RECRUIT, T0);
  assert.equal(d.action, "send");
  assert.equal(d.step.key, "t1");
  assert.equal(d.stepIndex, 0, "t1 is the first cold step");
});

test("skipping to a later step reports THAT step's index, not the next one", () => {
  // An opener at step 1: t2's gate refuses it, so the walk goes on to t3.
  // t3 is index 2 in the cold track. Advancing by one would leave the run at 2,
  // pointing back AT t3 — and it would send again on the next tick.
  const d = nextDecision(afterT1(), RECRUIT, T0 + T3_AFTER_ENROL, { openState: "opened" });
  assert.equal(d.action, "send");
  assert.equal(d.step.key, "t3");
  assert.equal(d.stepIndex, 2, "reported the enrolment's index instead of the step's");

  // The contract the tick relies on: parking at stepIndex+1 leaves nothing
  // behind that could fire twice.
  const after = { ...afterT1(), step_index: d.stepIndex + 1 };
  const again = nextDecision(after, RECRUIT, T0 + T3_AFTER_ENROL + 1, { openState: "opened" });
  assert.equal(again.action, "stop", "the run re-sent a step it had already sent");
  assert.equal(again.reason, "exhausted");
});

test("a disabled step is walked over and does not claim the index", () => {
  const disabled = new Set(["recruit_cold:t2"]);
  const d = nextDecision(afterT1(), RECRUIT, T0 + T3_AFTER_ENROL, { disabledSteps: disabled });
  assert.equal(d.step.key, "t3");
  assert.equal(d.stepIndex, 2);
});

test("stepIndex always points at the step that was sent", () => {
  // The invariant, stated once: whatever the walk skipped, the index and the
  // step must agree — otherwise the tick cannot advance correctly.
  for (const openState of ["opened", "not_opened", "unknown"]) {
    for (const at of [T0, T0 + T2_AFTER_ENROL, T0 + T3_AFTER_ENROL]) {
      const d = nextDecision(enrol(), RECRUIT, at, { openState });
      if (d.action !== "send") continue;
      const coldSteps = RECRUIT.steps.filter((s) => s.track === "cold");
      assert.equal(coldSteps[d.stepIndex].key, d.step.key, `mismatch at ${at} / ${openState}`);
    }
  }
});
