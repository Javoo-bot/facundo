// Pure stop rules for the offer-wave refill loop. Zero imports on purpose —
// same reasoning as cxAttentionRules.ts: plain `node --test` (and, if it ever
// needs it, ingest-worker's vitest) can import this by relative path without
// the `@/*` alias a Next.js build resolves.
//
// THE RULE, in one line: keep offering while there is still time for the next
// offer to run its window AND leave CX a reserve — up to a hard ceiling on
// waves.
//
// Why two guards rather than one: they bind in different situations, and each
// alone leaves a bad case open.
//   * The ceiling alone would let a 5-day-out order spend 24h working down a
//     list nobody is answering.
//   * The time reserve alone would let a far-future order cold-mail an entire
//     city, because there is always "enough time" for one more wave.
// Whichever fires first wins.

/** Why the wave engine stopped refilling. Also the vocabulary written to
 *  `orders.escalation_reason` and the `escalated` order event's payload. */
export type EscalationReason =
  /** A refill actually ran and came back empty: every matchable shop in range
   *  has been tried. A coverage problem — CX places it by hand and Recruiting
   *  should look at the area. Only ever set by the auto path, because it is the
   *  only one that looks past the order's own candidate list. */
  | "pool_exhausted"
  /** The order's candidate list ran out and we did NOT look further — semi and
   *  manual mode, where refilling would pre-empt the human the mode exists to
   *  ask. Deliberately makes no claim about the pool; untried shops may remain.
   *  Also the value every pre-refill row carries. */
  | "candidates_exhausted"
  /** Hit `match_max_waves`. Untried shops may well remain — so the useful CX
   *  action is often "keep going", not "place it by hand". */
  | "wave_ceiling"
  /** Stopped deliberately with time to spare, so a human can still place it
   *  inside `cx_reserve_hours`. The urgent one. */
  | "out_of_time"
  /** `delivery_at` has already passed. Pre-existing reason, unchanged. */
  | "past_delivery_deadline"
  /** The florist who ACCEPTED went dark past the fulfilment SLA and there was
   *  no candidate left to reassign to. Not a refill outcome — written by the
   *  accept-SLA branch — but it escalates onto the same desk, so it shares the
   *  vocabulary rather than leaving that order's reason null. */
  | "accept_sla_breach_no_candidates";

/** What the pre-refill wave engine wrote whenever a list ran out, and what
 *  semi/manual still write. Kept as a named constant because older `escalated`
 *  events carry it and the desk must keep rendering them sensibly. */
export const LEGACY_EXHAUSTED_REASON = "candidates_exhausted";

export interface RefillGuardInput {
  /** Waves already run for this order, INCLUDING the initial match's wave.
   *  1 = only the first `match_top_n` candidates have been worked. */
  wavesSoFar: number;
  /** `app_settings.match_max_waves`. */
  maxWaves: number;
  /** Minutes the NEXT offer would get, from the urgency ladder
   *  (lib/reachout.ts::suggestedTimeoutMinutes). Passed in rather than
   *  recomputed here so this module stays import-free — and so the caller is
   *  forced to use the same ladder the send path locks in. */
  nextWindowMin: number;
  /** `app_settings.cx_reserve_hours`. */
  cxReserveHours: number;
  /** The order's delivery deadline. Null = no date; the time guard cannot be
   *  evaluated and the ceiling becomes the only bound. */
  deliveryAt: string | null;
  nowMs: number;
}

export type RefillDecision = { refill: true } | { refill: false; reason: EscalationReason };

/**
 * May the wave engine run another wave for this order?
 *
 * Order of checks matters for the REPORTED reason, not for correctness: an
 * order that is both past its ceiling and out of time is reported as
 * `out_of_time`, because that is the one that changes what a human does next
 * (place it now vs decide whether to keep going).
 *
 * A refusal here is not a failure — it is the loop handing over deliberately,
 * which is the whole point of the reserve.
 */
export function refillDecision(input: RefillGuardInput): RefillDecision {
  const { wavesSoFar, maxWaves, nextWindowMin, cxReserveHours, deliveryAt, nowMs } = input;

  // Time first, so the urgent reason wins when both apply.
  if (deliveryAt != null) {
    const deadlineMs = new Date(deliveryAt).getTime();
    // An unparseable date must not silently disable the guard — treat it as
    // "no date" (ceiling only) rather than as "infinite time".
    if (Number.isFinite(deadlineMs)) {
      const windowEndsMs = nowMs + Math.max(0, nextWindowMin) * 60_000;
      const reserveMs = Math.max(0, cxReserveHours) * 3_600_000;
      if (windowEndsMs > deadlineMs - reserveMs) return { refill: false, reason: "out_of_time" };
    }
  }

  // A ceiling below 1 would mean "never offer anybody", which no setting should
  // be able to express — the floor is 1 (one wave, then escalate: the
  // pre-refill behavior).
  if (wavesSoFar >= Math.max(1, maxWaves)) return { refill: false, reason: "wave_ceiling" };

  return { refill: true };
}

/** Short label per reason, for the CX desk row. Kept here so the desk, the
 *  approval preview and the alert sweep can't drift apart. */
export function escalationReasonLabel(reason: EscalationReason | string | null): string {
  switch (reason) {
    case "out_of_time":
      return "Out of time — place this now";
    case "wave_ceiling":
      return "No answer after every wave — untried shops remain";
    case "pool_exhausted":
      return "No florist left in range — escalated";
    case LEGACY_EXHAUSTED_REASON:
      // Says only what we know: this order's list ran out. Whether the city
      // holds more shops was never checked on this path.
      return "Candidate list exhausted — escalated";
    case "past_delivery_deadline":
      return "Past the delivery deadline";
    case "accept_sla_breach_no_candidates":
      return "Florist went dark, nobody left to hand it to";
    default:
      // Null for orders escalated by a path that predates the column, or by
      // staff. The old generic wording, so nothing reads as newly broken.
      return "No florist found — escalated";
  }
}

/** Full sentence for the semi-mode escalate approval, which asks a human to
 *  approve the hand-off rather than just labelling one that happened. Separate
 *  from the label because "Out of time — place this now — hand to CX" reads as
 *  nonsense; each reason needs its own verb. */
export function escalationApprovalPreview(reason: EscalationReason | string | null): string {
  switch (reason) {
    case "out_of_time":
      return "Not enough time left for another offer window — hand to CX now, while there is still time to place it manually.";
    case "wave_ceiling":
      return "Every wave went unanswered and the wave ceiling is reached. Untried florists may remain — hand to CX to decide between more waves and placing it manually.";
    case "past_delivery_deadline":
      return "Past the delivery deadline — hand to CX to place manually.";
    case "accept_sla_breach_no_candidates":
      return "The accepting florist went dark and there is no candidate left to hand it to — hand to CX to place manually.";
    case "pool_exhausted":
      return "Every florist in range has been tried — hand to CX to place manually.";
    case LEGACY_EXHAUSTED_REASON:
    default:
      return "All candidates exhausted — hand to CX to place manually.";
  }
}
