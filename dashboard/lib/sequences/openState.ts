// What we actually know about whether a prospect opened the first email.
//
// Pure and alias-free so `node --test` reaches it, and so the funnel's most
// consequential branch is one screen you can assert on.
//
// ---- Why THREE values and not a boolean
//
// The one-day funnel gates two of its three touches on opens: t2 goes to people
// who did not open, t3 to people who did but did not click. Written as a
// boolean that is a trap, because `false` would have to mean both "we know they
// ignored it" and "we have not heard anything", and those demand opposite
// behaviour:
//
//   - Real non-opener            → t2 SHOULD fire, t3 should not.
//   - No provider feedback at all → we know nothing, so gating either way is a
//                                   guess. Both must fire.
//
// The second case is not hypothetical. `email_events` is fed only by the Resend
// webhook, so it is empty for any send on a transport without one, and it is
// empty for any single message whose webhook was dropped, retried past its
// deadline, or fired while a deploy was rolling. Collapse `unknown` into
// `not_opened` and t3 silently stops existing for those shops — the funnel
// quietly becomes a two-touch funnel and nothing anywhere reports it. Collapse
// it into `opened` and t2 disappears the same way.
//
// So `unknown` satisfies BOTH gates. Under complete feedback the funnel splits
// the way it was designed to; under no feedback it degrades exactly to the
// unbranched behaviour that shipped before this change, which is the only safe
// thing for it to degrade to.

import { isGenuineOpen } from "./openQuality.ts";

export type OpenState = "opened" | "not_opened" | "unknown";

/** One message's provider feedback, as the funnel needs to read it. */
export interface MessageFeedback {
  /** `delivered` event timestamp, if any. */
  deliveredAt?: string | number | null;
  /** First `opened` event timestamp, if any. */
  openedAt?: string | number | null;
  /** How many `opened` events this message has. */
  openCount?: number | null;
  /** A click that already passed clickQuality. */
  hasHumanClick?: boolean | null;
  /** `bounced` or `complained` — proof the provider is reporting on this
   * message even though it was never opened. */
  bouncedAt?: string | number | null;
}

/** Did we hear ANYTHING at all about this message? */
function hasAnyFeedback(f: MessageFeedback): boolean {
  return Boolean(f.deliveredAt || f.openedAt || f.bouncedAt || f.hasHumanClick || (f.openCount ?? 0) > 0);
}

/**
 * Resolve one message's feedback to an open state.
 *
 * - Any genuine open (openQuality) → `opened`.
 * - Feedback exists but no genuine open → `not_opened`. The provider is
 *   evidently reporting on this message, so silence about opens is real
 *   information rather than a gap.
 * - No feedback whatsoever → `unknown`.
 */
export function openStateOf(f: MessageFeedback): OpenState {
  if (!hasAnyFeedback(f)) return "unknown";
  const genuine = isGenuineOpen({
    openedAt: f.openedAt,
    deliveredAt: f.deliveredAt,
    openCount: f.openCount,
    hasHumanClick: f.hasHumanClick,
  });
  return genuine ? "opened" : "not_opened";
}

/**
 * Resolve a whole RUN across the messages sent on it so far.
 *
 * A run is several messages and they can disagree — a shop that ignored t1 and
 * opened t2 has one of each. `opened` wins over `not_opened`, which wins over
 * `unknown`: the question every gate is really asking is "has this shop ever
 * shown us it reads our mail", and one genuine open answers it for good. Taking
 * the LAST message's state instead would let a shop that opened t1 and then had
 * a dropped webhook on t2 fall back to `unknown` and receive both follow-ups.
 */
export function openStateOfRun(messages: readonly MessageFeedback[]): OpenState {
  let seenFeedback = false;
  for (const m of messages) {
    const s = openStateOf(m);
    if (s === "opened") return "opened";
    if (s === "not_opened") seenFeedback = true;
  }
  return seenFeedback ? "not_opened" : "unknown";
}

/** The gate a step declares. `undefined` on a step means "no open condition". */
export type OpenGate = "not-opened" | "opened";

/**
 * May a step with this gate fire, given what we know?
 *
 * The `unknown` row is the whole point of the file — it satisfies every gate,
 * so absent feedback can never silence a touch.
 *
 * | gate        | opened | not_opened | unknown |
 * |-------------|--------|------------|---------|
 * | (none)      |  yes   |    yes     |   yes   |
 * | not-opened  |  no    |    yes     |   yes   |
 * | opened      |  yes   |    no      |   yes   |
 */
export function gateAllows(gate: OpenGate | undefined, state: OpenState): boolean {
  if (!gate) return true;
  if (state === "unknown") return true;
  return gate === "opened" ? state === "opened" : state === "not_opened";
}
