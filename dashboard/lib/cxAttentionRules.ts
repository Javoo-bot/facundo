// Pure, dependency-free classification rules used by lib/cxAttention.ts.
//
// WHY THIS FILE IS SEPARATE FROM cxAttention.ts: gatherAttention() itself pulls
// in `@/lib/workingSet`, `@/lib/workingSetServer`, `@/lib/i18n/issueLabels` and
// `@/lib/shopifyConflict` via the `@/*` tsconfig path alias. That alias is
// resolved by Next.js at build time; neither the dashboard's own test runner
// (plain `node --test` — see scripts/tests.mjs's EXCLUDED list, which already
// documents this exact failure mode for lib/apiAuth.ts) nor ingest-worker's
// vitest config understands it, so importing cxAttention.ts from either place
// throws before a single assertion runs.
//
// This file has zero imports, so it can be safely imported by relative path
// from ingest-worker (the same pattern already used for payoutMath.ts,
// payoutHold.ts, shopifyTags.ts and orderStatus.ts — see
// ingest-worker/test/e2e/orderLoop.e2e.test.ts's header) to prove, with the
// REAL classification code, that an order the loop couldn't place is one
// gatherAttention would surface to a human — without standing up a fake
// Supabase client that can answer every query gatherAttention issues.

// Order and offer statuses each rule of gatherAttention reads. Here rather than
// in cxAttention.ts so agents/factory/sweep-signals.mjs reads the same sets.
export const LIVE_OFFER = ["sent", "opened"];
export const IN_FULFILMENT = ["accepted", "in_production", "ready", "out_for_delivery"];
export const NEEDS_PLACING = ["escalated", "matched", "received"];

export type CxCategory ="approval" | "place" | "message" | "delivery" | "money";

export interface CxReason {
  category: CxCategory;
  label: string;
  urgency: number; // higher = more urgent
  slaAt: string | null; // a deadline to show an SLA/overdue chip against
  unread?: boolean;
  // Set when this reason is also rendered as its own interactive card in the
  // unified CX desk's "Proposed by the system" lane, so the exception table can
  // strip it (see lib/cxDesk.ts::toExceptionRows). Only held payouts need this
  // today — approvals are stripped by category.
  dedupeKind?: "held_payout";
}

// Mirrors gatherAttention's rule 1 ("Can't place — escalated (no florist) /
// awaiting reach-out"), fed one order at a time. Only ever called for orders
// already filtered to NEEDS_PLACING (escalated/matched/received) in
// cxAttention.ts, so any other status falls through to the "awaiting
// reach-out" branch exactly as the inline `else` used to.
//
// `escalationReason` (orders.escalation_reason, written by lib/waves.ts) splits
// what used to be one undifferentiated "No florist found" row. The distinction
// is not cosmetic — it decides what the human does:
//   out_of_time    → place it NOW; the wave engine stood down early on purpose
//                    to leave exactly this margin. Ranked above a stalling
//                    offer, because that margin is already running out.
//   wave_ceiling   → untried shops remain; the choice is "keep going" vs place
//                    by hand, so it sits just below a true dead end.
//   pool_exhausted → nobody left in range: place by hand AND go recruit here.
// An unknown or null reason keeps the original label and urgency, so orders
// escalated before this column existed read exactly as they did.
export function placementAttentionReason(
  status: string | null,
  deliveryAt: string | null,
  escalationReason?: string | null
): CxReason {
  if (status === "escalated") {
    switch (escalationReason) {
      case "out_of_time":
        return { category: "place", label: "Out of time — place this now", urgency: 105, slaAt: deliveryAt };
      case "wave_ceiling":
        return { category: "place", label: "No answer after every wave — untried shops remain", urgency: 85, slaAt: deliveryAt };
      // The list ran out and we deliberately did NOT look further — what semi
      // and manual mode always write, and what every pre-refill row carries
      // (waveGuards.ts::LEGACY_EXHAUSTED_REASON). It was falling through to the
      // default below, which reads "No florist found" — a claim this reason
      // explicitly does not make: nobody looked past the first list, so untried
      // shops may well remain. Same urgency as `wave_ceiling`, whose situation
      // it matches: the useful action is usually "keep going", not "place by
      // hand". Surfaced by the Operator panel on 2026-09-01, where the wrong
      // sentence was the visible symptom.
      case "candidates_exhausted":
        return { category: "place", label: "The list of shops ran out — nobody looked further", urgency: 85, slaAt: deliveryAt };
      case "pool_exhausted":
        return { category: "place", label: "No florist left in range — escalated", urgency: 90, slaAt: deliveryAt };
      case "accept_sla_breach_no_candidates":
        return { category: "place", label: "Florist went dark, nobody left to hand it to", urgency: 95, slaAt: deliveryAt };
      case "past_delivery_deadline":
        return { category: "place", label: "Past the delivery deadline", urgency: 100, slaAt: deliveryAt };
      default:
        return { category: "place", label: "No florist found — escalated", urgency: 90, slaAt: deliveryAt };
    }
  }
  return { category: "place", label: "Awaiting reach-out", urgency: 40, slaAt: deliveryAt };
}

// ---------------------------------------------------------------------------
// Engaged, then silent: a florist opened or clicked an offer that later
// expired, and the order is still unplaced.
//
// WHY: that florist is the warmest lead CX has, and the loop throws the signal
// away. On order #2000034 a French florist clicked his offer twice, 67 and 72
// minutes after it arrived, and emailed us a question 43 minutes before it
// expired. The email bounced, the offer expired, and the order sat unplaced
// for five days while the desk showed only "Needs next florist". One phone call
// would very likely have placed it.
//
// Mail security scanners also "click" every link, seconds after delivery, and
// that must not read as interest. There is no clean cut in the data: measured
// over every non-test offer email on 2026-09-16, first clicks landed <10s after
// delivery 6 times, 10-60s 23 times, 1-5min 28, 5-60min 50, >1h 57. Scanners
// sit at the fast end but a quick human does too. So a click only counts once
// it is at least a minute after delivery; a portal visit (opened_at) always
// counts, because a scanner does not sign in. Deliberately conservative: a
// missed lead costs a call, a false one costs CX a pointless call.
// ---------------------------------------------------------------------------

export const HUMAN_CLICK_MIN_DELAY_MS = 60_000;

export interface OfferEngagementEvidence {
  /** order_assignments.opened_at — the florist actually opened the offer page. */
  openedAt: string | null;
  /** Every email click on this assignment's offer, with that email's delivery time. */
  clicks: { clickedAt: string; deliveredAt: string | null }[];
}

/** True when the evidence says a PERSON engaged with the offer, not a scanner. */
export function isHumanEngagement(e: OfferEngagementEvidence): boolean {
  if (e.openedAt) return true;
  return e.clicks.some(({ clickedAt, deliveredAt }) => {
    const clicked = Date.parse(clickedAt);
    if (Number.isNaN(clicked)) return false;
    // No delivery receipt to measure against: cannot rule a scanner out, so it
    // does not count. Delivery receipts are reliable on the Resend path.
    if (!deliveredAt) return false;
    const delivered = Date.parse(deliveredAt);
    if (Number.isNaN(delivered)) return false;
    return clicked - delivered >= HUMAN_CLICK_MIN_DELAY_MS;
  });
}

/** Above "Needs next florist" (85): a known-interested shop is a better next
 * step than a cold one. Below a true dead end (90) and anything out of time. */
export const ENGAGED_THEN_SILENT_REASON: CxReason = {
  category: "place",
  label: "A florist opened this offer but never answered",
  urgency: 86,
  slaAt: null,
};

// ---------------------------------------------------------------------------
// AI photo check inconclusive or negative. Until 2026-08-20 a `review`/`fail`
// verdict parked the delivery leg for a human (lib/payoutHold.ts); an audit of
// every verdict then written found the check wasn't calibrated well enough to
// gate real money on, so the HOLD was switched off. The check itself, and the
// recording to `photo_verifications`, were left running — but nothing told a
// human the finding existed, so "a person has to look at the photo" (the
// agent's own job, per agents/thinking/hawkeye.md) stopped happening. This is
// that missing surface, not a reversal of the money decision: it only adds
// visibility, same as every other gatherAttention rule.
// ---------------------------------------------------------------------------

export interface PhotoVerificationRow {
  assignmentId: string;
  orderId: string;
  verdict: "pass" | "review" | "fail";
  createdAt: string;
}

// Urgent tier, next to "no florist left in range" (90) and "florist went dark" (95):
// the payout is no longer held on these verdicts, so a person is the only check
// left (the owner, 2026-10-14).
const PHOTO_VERDICT_REASON: Record<"review" | "fail", { label: string; urgency: number }> = {
  review: { label: "AI photo check could not decide — a person should look", urgency: 90 },
  fail: { label: "AI photo check says this isn't the order — a person should look", urgency: 95 },
};

/** One reason per order whose assignment's MOST RECENT delivery-photo verdict
 * is `review`/`fail`. A later re-upload that comes back `pass` clears it —
 * re-uploads still happen post-2026-08-20 for a leg held on some OTHER ground
 * (e.g. tier-hold), so the same "latest wins" rule the florist-facing retry
 * flow uses (lib/photoFeedback.ts) applies here too. Takes every row for the
 * affected assignments, any verdict, so the caller does the filtering query —
 * "most recent" can only be computed once all of an assignment's rows are in
 * hand. */
export function photoVerdictAttentionReasons(
  rows: PhotoVerificationRow[]
): { orderId: string; reason: CxReason }[] {
  const latestByAssignment = new Map<string, PhotoVerificationRow>();
  for (const r of rows) {
    const prev = latestByAssignment.get(r.assignmentId);
    if (!prev || r.createdAt > prev.createdAt) latestByAssignment.set(r.assignmentId, r);
  }
  const out: { orderId: string; reason: CxReason }[] = [];
  for (const r of latestByAssignment.values()) {
    if (r.verdict !== "review" && r.verdict !== "fail") continue;
    const { label, urgency } = PHOTO_VERDICT_REASON[r.verdict];
    out.push({ orderId: r.orderId, reason: { category: "delivery", label, urgency, slaAt: null } });
  }
  return out;
}
