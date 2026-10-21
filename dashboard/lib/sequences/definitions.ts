// The shape of every outreach funnel: which touches, in what order, on what
// clock, through which channels, in whose voice.
//
// Pure data, alias-free, no I/O — the same "structure in typed code, copy in
// the catalog" split lib/messages/registry.ts already uses. The marketing lead can rewrite
// every word from /messages with no deploy; changing the funnel's SHAPE is a
// code change, which is correct, because the shape is logic.
//
// ---- The cold-recruiting funnel ----
//
// SAME-DAY as of 2026-09-09. It used to run day 0 / 3 / 7; it now resolves
// inside one working day, and the two follow-ups branch on whether the prospect
// OPENED rather than only on whether they clicked:
//
//   09:00   t1  email (+ SMS)   company, branded   the situation
//     ├─ did NOT open ─────────────────────────────────────────┐
//   12:30   t2  email           persona, plain     we're short here
//     ├─ opened, no click ─────────────────────────────────────┤
//   17:00   t3  email           persona, plain     how the money works
//     → exhausted (long-term nurture)
//
//   A FIRST CLICK at any point immediately exits the no-engagement track:
//
//   click +45m  r1  email + SMS  persona, plain    "what stopped you?"
//   r1    +4h   r2  email        persona, plain    the graceful exit
//   → exhausted
//
// Two things make the compressed clock safe, and neither lives here:
//   - sendWindow.ts pins every touch to 09:00–20:00 Europe/Madrid. Without it
//     a shop enrolled at 02:00 is judged a non-opener at 05:30, which measures
//     what time we enrolled them rather than whether they are interested.
//   - openState.ts resolves opens three ways, so `unknown` (no provider
//     feedback) satisfies BOTH gates and a dropped webhook cannot silence a
//     step.
//
// It also requires `app_settings.sequence_min_gap_hours` to be well under the
// 3.5h t1→t2 gap. At the historical default of 48 the min-gap floor defers
// every follow-up and the funnel silently becomes one email.
//
// Caps: 3 touches for a prospect who never engages; 4 emails + 1 SMS for one
// who does. Both are enforced in schedule.ts, not here — this file is the
// score, schedule.ts is the metronome.

import type { EmailVoice } from "../messageVoice.ts";
import type { OpenGate } from "./openState.ts";

export type SequenceId =
  | "recruit_cold"
  | "cold_offer_followup"
  | "reactivate_never_accepted"
  | "reactivate_dormant";

/** Who a sequence is FOR, which decides the opposite eligibility rules.
 *
 *  - `prospect`: a shop outside the network. Joining ENDS the run — the pitch
 *    is no longer for them.
 *  - `network`: a florist who already joined. Joining is the PRECONDITION;
 *    a run against a shop that never joined would be nonsense.
 *
 * Without this distinction the tick's "they joined, stop" rule — correct for
 * recruiting — would kill every reactivation run on its first tick. */
export type SequenceAudience = "prospect" | "network";

export type TouchChannel = "email" | "sms";

/** Which track a step belongs to. `cold` steps are skipped once a prospect has
 * clicked; `reengage` steps only ever run after one. */
export type Track = "cold" | "reengage";

/** What the step's clock is measured from.
 *  - `enrolled`: days since the enrolment was created (the cold track).
 *  - `engaged`: days since the FIRST click (the re-engagement track's anchor).
 *  - `prevStep`: days since the previous touch actually went out. */
export type Anchor = "enrolled" | "engaged" | "prevStep";

export interface SequenceStep {
  /** Matches the copy namespace (`email.recruit.<key>`) and the message-voice
   * kind (`recruit.<key>`), so a step, its words and its look cannot drift
   * apart under three different names. */
  key: string;
  track: Track;
  anchor: Anchor;
  /** Days after the anchor. Fractional is allowed — the cold-offer follow-up
   * works in hours, because an order is a much shorter-lived hook.
   *
   * Prefer `hours` below for anything under a day: 3½ hours written here is
   * `0.1458`, and a wrong digit in that is both easy to typo and impossible to
   * spot in review. Exactly one of the two should be set. */
  days?: number;
  /** Hours after the anchor — the same clock as `days`, in the unit the
   * recruiting funnel actually reasons in since it became same-day. Wins over
   * `days` when both are set. */
  hours?: number;
  /** Open condition. `undefined` = send regardless, which is every step that
   * predates the one-day funnel. See openState.ts: a gate NEVER blocks a step
   * when the open state is `unknown`, so a missing webhook cannot silence a
   * touch. */
  gate?: OpenGate;
  channels: TouchChannel[];
  /** Who it comes from. `persona` steps are skipped when the market has no
   * active persona — an unsigned "personal" email is worse than none. */
  from: "company" | "persona";
  /** Overrides the per-kind voice in Settings. Set deliberately per step: the
   * first email is from a company and looks it; every follow-up is from a
   * person and must not. */
  voice?: EmailVoice;
  /** Copy namespace, i.e. `email.<ns>.<key>` and the message-voice kind
   * `<ns>.<key>`. Defaults to "recruit" so every existing step is unchanged. */
  ns?: string;
  /** Set only on a DUPLICATE (lib/flows/customSteps.ts). The built-in step
   * whose shape this borrows — which paragraphs it has, and therefore which
   * leaves the builder looks for. Its WORDS come from this step's own keys,
   * which is what makes a copy independent of the original. Never set on a
   * step in this file: the funnel's built-in shape is code. */
  copyOf?: string;
}

export interface SequenceDef {
  id: SequenceId;
  audience: SequenceAudience;
  steps: SequenceStep[];
  /** Max touches for a prospect who never clicks. */
  maxColdTouches: number;
  /** Max EMAIL touches once engaged (counted across both tracks). */
  maxEmailTouches: number;
  /** Max SMS touches, ever. Cold texting is the send most likely to be
   * remembered as spam, and the cheapest to get wrong. */
  maxSmsTouches: number;
}

const RECRUIT_COLD: SequenceDef = {
  id: "recruit_cold",
  audience: "prospect",
  maxColdTouches: 3,
  maxEmailTouches: 4,
  maxSmsTouches: 2,
  steps: [
    // Hour 0 is sent by the outreach panel itself (that's what enrols them), so
    // it is recorded here as step 0 with hours: 0 — the tick never re-sends it.
    { key: "t1", track: "cold", anchor: "enrolled", hours: 0, channels: ["email", "sms"], from: "company", voice: "branded" },
    // 3½ hours, and gated on NOT having opened. Roughly 60% of everyone who
    // ever opens a B2B email has done so by then, so the gate is measuring
    // something; at 2 hours it would mostly be measuring who was at their desk.
    // Inside the 09:00 send window it also lands at 12:30, before the 14:00
    // Spanish lunch shutdown rather than into it.
    { key: "t2", track: "cold", anchor: "enrolled", hours: 3.5, gate: "not-opened", channels: ["email"], from: "persona", voice: "plain" },
    // 8 hours — 17:00, the late-afternoon inbox check — and gated on HAVING
    // opened without clicking. 4.5 hours after t2 so that a shop which somehow
    // qualifies for both never receives them as a burst.
    { key: "t3", track: "cold", anchor: "enrolled", hours: 8, gate: "opened", channels: ["email"], from: "persona", voice: "plain" },
    // The re-engagement track. `engaged` anchors both steps to the click, so a
    // prospect who clicks at 09:05 and one who clicks at 18:00 get the same
    // 45-minute pause — the clock belongs to their action, not to ours. No open
    // gate on either: a click already proves the message was seen, and gating
    // on opens too would let a dropped `opened` webhook mute the branch that
    // matters most.
    { key: "r1", track: "reengage", anchor: "engaged", hours: 0.75, channels: ["email", "sms"], from: "persona", voice: "plain" },
    { key: "r2", track: "reengage", anchor: "prevStep", hours: 4, channels: ["email"], from: "persona", voice: "plain" },
  ],
};

// The cold-offer bridge. A real order we offered to a shop outside the network
// has gone elsewhere, and this is the follow-up. Deliberately short-horizon and
// email-only: the order is already gone, so there is nothing urgent enough to
// justify a text, and the hook decays fast.
const COLD_OFFER_FOLLOWUP: SequenceDef = {
  id: "cold_offer_followup",
  audience: "prospect",
  maxColdTouches: 2,
  maxEmailTouches: 2,
  maxSmsTouches: 0,
  steps: [
    { key: "co1", track: "cold", anchor: "enrolled", days: 0.5, channels: ["email"], from: "persona", voice: "plain" },
    { key: "co2", track: "cold", anchor: "prevStep", days: 4, channels: ["email"], from: "persona", voice: "plain" },
  ],
};

// ---- Reactivation: florists who ALREADY joined ----
//
// A different problem from recruiting, and a better one: they said yes once.
// What went wrong is either that they never took a first order (the hardest
// step, and often just nerves about how the money works) or that they took one
// and drifted. Two sequences because those are two different conversations —
// telling a shop that has never delivered for us "it's been a while" would be
// obviously wrong, and would tell them nobody is paying attention.
//
// Email only. These are partners, not strangers: an unexpected text to someone
// we already have a working relationship with spends goodwill we now have, and
// the SMS channel is already reserved for real orders, which is what they
// actually want to hear about.
const REACTIVATE_NEVER_ACCEPTED: SequenceDef = {
  id: "reactivate_never_accepted",
  audience: "network",
  maxColdTouches: 2,
  maxEmailTouches: 2,
  maxSmsTouches: 0,
  steps: [
    { key: "ra1", ns: "reactivate", track: "cold", anchor: "enrolled", days: 0, channels: ["email"], from: "persona", voice: "plain" },
    { key: "ra2", ns: "reactivate", track: "cold", anchor: "prevStep", days: 7, channels: ["email"], from: "persona", voice: "plain" },
  ],
};

const REACTIVATE_DORMANT: SequenceDef = {
  id: "reactivate_dormant",
  audience: "network",
  maxColdTouches: 2,
  maxEmailTouches: 2,
  maxSmsTouches: 0,
  steps: [
    { key: "rd1", ns: "reactivate", track: "cold", anchor: "enrolled", days: 0, channels: ["email"], from: "persona", voice: "plain" },
    { key: "rd2", ns: "reactivate", track: "cold", anchor: "prevStep", days: 10, channels: ["email"], from: "persona", voice: "plain" },
  ],
};

export const SEQUENCES: Record<SequenceId, SequenceDef> = {
  recruit_cold: RECRUIT_COLD,
  cold_offer_followup: COLD_OFFER_FOLLOWUP,
  reactivate_never_accepted: REACTIVATE_NEVER_ACCEPTED,
  reactivate_dormant: REACTIVATE_DORMANT,
};

export const SEQUENCE_IDS: readonly SequenceId[] = [
  "recruit_cold",
  "cold_offer_followup",
  "reactivate_never_accepted",
  "reactivate_dormant",
];

export function isSequenceId(x: unknown): x is SequenceId {
  return typeof x === "string" && (SEQUENCE_IDS as string[]).includes(x);
}

export function sequenceDef(id: SequenceId): SequenceDef {
  return SEQUENCES[id];
}

/** The message-voice kind and copy namespace for a step. One derivation, so
 * Settings, the catalog and the send site can never disagree about a step. */
export function stepKind(step: SequenceStep): string {
  return `${step.ns ?? "recruit"}.${step.key}`;
}
