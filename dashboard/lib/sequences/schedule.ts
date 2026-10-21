// The metronome: given an enrolment and the clock, what happens next?
//
// Pure and alias-free — no I/O, no Date.now(), `now` is always passed in — so
// the funnel's timing is executable in a unit test rather than something you
// find out about three days after a send. This is the single most valuable
// file in the sequence engine to keep honest; lib/sequences/tick.ts is a thin
// I/O wrapper around it.

import { type SequenceDef, type SequenceStep, type TouchChannel } from "./definitions.ts";
import { gateAllows, type OpenState } from "./openState.ts";
import { nextSendTime, type WindowOptions } from "./sendWindow.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** A step's offset from its anchor, in ms. `hours` wins over `days` when both
 * are set; a step with neither is treated as due at its anchor. Kept here
 * rather than in definitions.ts so that file stays pure data. */
export function stepOffsetMs(step: SequenceStep): number {
  if (typeof step.hours === "number") return step.hours * HOUR_MS;
  if (typeof step.days === "number") return step.days * DAY_MS;
  return 0;
}

/** The persisted state of one florist's run through one sequence. Mirrors the
 * `sequence_enrolments` row, minus the columns the scheduler doesn't read. */
export interface Enrolment {
  sequence_id: string;
  status: "active" | "paused" | "converted" | "stopped" | "exhausted";
  track: "cold" | "reengage";
  /** How many steps of the CURRENT track have been sent. */
  step_index: number;
  created_at: string;
  /** First click on any link, any channel. Null until they engage. */
  engaged_at: string | null;
  /** When the last touch actually went out. Null before the first one. */
  last_touch_at: string | null;
  touches_email: number;
  touches_sms: number;
}

export type Decision =
  /** `stepIndex` is WHERE IN THE TRACK the sent step actually sits, which is not
   * necessarily the enrolment's current `step_index`: the walk below skips
   * disabled steps, persona-less steps, capped ones and — since the same-day
   * funnel — steps whose open gate does not match. The caller MUST advance the
   * enrolment past this index rather than by one, or the run rewinds onto the
   * steps it just skipped and sends them again. */
  | { action: "send"; step: SequenceStep; stepIndex: number; channels: TouchChannel[]; nextActionAt: string }
  | { action: "wait"; until: string }
  | { action: "stop"; reason: StopReason };

export type StopReason = "exhausted" | "cap_email" | "cap_sms" | "cap_cold" | "not_active";

export interface ScheduleOptions {
  /** Minimum hours between any two touches to the same florist, across every
   * sequence. Defends against a prospect who clicks on the morning of day 3
   * getting the day-3 cold email and the re-engagement email hours apart. */
  minGapHours?: number;
  /** False when the market has no active persona. Persona-signed steps are
   * SKIPPED rather than sent unsigned — see nextDecision. */
  hasPersona?: boolean;
  /** Steps switched off from /flows, as `${sequenceId}:${stepKey}` (the same
   * key lib/flows/timing.ts uses). A step in here is SKIPPED — the run moves
   * on to the next one rather than stopping, so switching off the middle touch
   * of a funnel leaves the last one reachable. Keyed by sequence as well as
   * step so turning off one funnel's `co1` cannot silence another's. */
  disabledSteps?: ReadonlySet<string>;
  /** What we know about this prospect's opens. Defaults to `unknown`, which
   * satisfies every gate — so a caller that does not resolve open state gets
   * exactly the pre-gate behaviour rather than a silently muted funnel. */
  openState?: OpenState;
  /** Confine sends to business hours. Omitted = no window, which is what every
   * caller outside the recruiting funnel wants. */
  sendWindow?: WindowOptions | null;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** The steps of the track the enrolment is currently on, in order. */
export function trackSteps(def: SequenceDef, track: "cold" | "reengage"): SequenceStep[] {
  return def.steps.filter((s) => s.track === track);
}

/** When `step` is due, given the enrolment's anchors. Returns null when the
 * anchor it needs hasn't happened yet (e.g. a `prevStep` step with no previous
 * touch), which the caller treats as "not schedulable". */
export function dueAt(step: SequenceStep, e: Enrolment): number | null {
  const anchor =
    step.anchor === "enrolled" ? ms(e.created_at)
    : step.anchor === "engaged" ? (e.engaged_at ? ms(e.engaged_at) : null)
    : e.last_touch_at ? ms(e.last_touch_at) : null;
  if (anchor === null || Number.isNaN(anchor)) return null;
  return anchor + stepOffsetMs(step);
}

/** Which channels of a step may actually be used, given the caps already spent.
 * A step whose email leg is capped can still text, and vice versa — the caps
 * are per channel because their costs and their risks are different. */
export function allowedStepChannels(step: SequenceStep, e: Enrolment, def: SequenceDef): TouchChannel[] {
  return step.channels.filter((c) =>
    c === "email" ? e.touches_email < def.maxEmailTouches : e.touches_sms < def.maxSmsTouches
  );
}

/**
 * What to do with this enrolment right now.
 *
 * Ordering matters and is deliberate:
 *   1. Not active → nothing. Paused enrolments are resumed elsewhere (enrol.ts),
 *      not here; the scheduler never un-pauses anything on its own.
 *   2. Track exhausted → stop.
 *   3. The cold-touch cap → stop. This is the marketing lead's "max 3 touches for a
 *      never-engaged prospect", and it is checked BEFORE the step's own clock so
 *      a fourth cold touch can never be scheduled, only then rejected.
 *   4. Not due yet → wait.
 *   5. The min-gap floor → wait (never drop the touch; just delay it).
 *   6. Switched off, every channel capped, or a persona step with no persona →
 *      skip the step and re-decide, so one unusable step doesn't strand the
 *      rest of the run.
 */
export function nextDecision(
  e: Enrolment,
  def: SequenceDef,
  nowMs: number,
  opts: ScheduleOptions = {}
): Decision {
  const { minGapHours = 0, hasPersona = true, disabledSteps, openState = "unknown", sendWindow = null } = opts;

  if (e.status !== "active") return { action: "stop", reason: "not_active" };

  const steps = trackSteps(def, e.track);

  // Walk forward from the current index so a skipped step (capped channels, no
  // persona) advances rather than blocking.
  for (let i = e.step_index; i < steps.length; i++) {
    const step = steps[i];

    // The cold-track touch cap. Counted across channels: three touches means
    // three messages, not three emails plus three texts.
    if (e.track === "cold" && !e.engaged_at) {
      const sent = e.touches_email + e.touches_sms;
      if (sent >= def.maxColdTouches) return { action: "stop", reason: "cap_cold" };
    }

    const due = dueAt(step, e);
    if (due === null) continue; // anchor hasn't happened — this step isn't schedulable

    // Switched off by staff. Skipped exactly like an unusable step: the run
    // carries on to the next touch instead of stalling here, and this step's
    // caps are left untouched, so switching it back on resumes normally.
    if (disabledSteps?.has(`${def.id}:${step.key}`)) continue;

    // The open gate. Skipped exactly like a disabled step — the run walks on to
    // the next touch — because t2 and t3 are ALTERNATIVES: a shop that opened
    // is meant to skip t2 and land on t3, and one that did not is meant to take
    // t2 and skip t3. Stopping here instead would end the run at whichever gate
    // it failed first, which for an opener is t2, i.e. the majority of the
    // funnel would silently become one email.
    //
    // `unknown` passes every gate (openState.ts), so no-feedback degrades to
    // the unbranched funnel rather than to a muted one.
    if (!gateAllows(step.gate, openState)) continue;

    const channels = allowedStepChannels(step, e, def);
    // Both legs capped, or a personal email with nobody to sign it. Skip the
    // step rather than sending something wrong.
    if (channels.length === 0 || (step.from === "persona" && !hasPersona)) continue;

    if (nowMs < due) return { action: "wait", until: new Date(due).toISOString() };

    // The frequency floor. Delays, never drops — the message is still owed.
    if (minGapHours > 0 && e.last_touch_at) {
      const earliest = ms(e.last_touch_at) + minGapHours * 60 * 60 * 1000;
      if (nowMs < earliest) return { action: "wait", until: new Date(earliest).toISOString() };
    }

    // Business hours. Last of the wait checks on purpose: a step must be due,
    // permitted and past the frequency floor before we ask whether now is a
    // civil hour to send it. Delays, never drops — same contract as the floor
    // above. Without this the one-day funnel's open gate degenerates into a
    // measure of what time we happened to enrol the shop (see sendWindow.ts).
    if (sendWindow) {
      const sendAt = nextSendTime(nowMs, sendWindow);
      if (sendAt > nowMs) return { action: "wait", until: new Date(sendAt).toISOString() };
    }

    // When the NEXT step is due, so the caller can park the enrolment on one
    // timestamp instead of polling it every minute.
    const next = steps[i + 1];
    const nextDue = next
      ? dueAt(next, { ...e, step_index: i + 1, last_touch_at: new Date(nowMs).toISOString() })
      : null;
    // Park the row on the next in-window instant rather than the raw due time,
    // so an evening due date does not wake the tick at 21:00 only to re-park
    // itself at 09:00. Purely an efficiency choice — the wait check above is
    // what actually enforces the window.
    const parkAt = nextDue ?? nowMs + DAY_MS;

    return {
      action: "send",
      step,
      stepIndex: i,
      channels,
      nextActionAt: new Date(sendWindow ? nextSendTime(parkAt, sendWindow) : parkAt).toISOString(),
    };
  }

  return { action: "stop", reason: "exhausted" };
}

/**
 * The enrolment as it should look the moment a first click lands.
 *
 * The switch is immediate and total: the cold track is abandoned mid-flight,
 * `step_index` resets to 0 for the re-engagement track, and the clock re-anchors
 * to the click. The marketing lead's rule is "the first click at any point exits the
 * no-engagement sequence" — a prospect who is on the signup page right now must
 * not receive tomorrow's "just following up, no rush" email.
 *
 * Idempotent: a second click changes nothing. Corporate link scanners (Outlook
 * Safe Links, Proofpoint) click every URL in an email, sometimes more than once,
 * so this being a no-op after the first is load-bearing rather than tidiness.
 */
export function applyEngagement(e: Enrolment, atIso: string): Enrolment {
  if (e.engaged_at) return e;
  if (e.status !== "active") return e;
  return { ...e, engaged_at: atIso, track: "reengage", step_index: 0 };
}
