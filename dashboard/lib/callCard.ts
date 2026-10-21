// The call screen's decisions, as pure functions.
//
// `/orders/[id]` is a card, not a database dump: it answers "who am I calling
// and what am I asking for" and offers one thing to record afterwards. The
// full record it replaced still exists, one link away, at
// `/orders/[id]/record`.
//
// Everything here is pure so it can be tested without a database — see
// lib/callCard.test.mjs. The page does the fetching; this file only decides
// WHICH shop to put on the card and WHAT to say about them.

import type { AssignmentStatus } from "./orderStatus";

/** One candidate, flattened from an assignment + its florist + its engagement. */
export interface CallCandidate {
  assignmentId: string;
  floristId: string;
  rank: number | null;
  status: AssignmentStatus;
  withdrawnAt: string | null;
  payoutPrice: number | null;
  declineReason: string | null;
  declineDetail: string | null;
  declinedAt: string | null;
  name: string;
  /** phone_maps, falling back to phone_web. Null = we cannot call them. */
  phone: string | null;
  ownerName: string | null;
  lifecycleStage: string;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  /** Straight-line km to the delivery point, or null when either end lacks coords. */
  distanceKm: number | null;
  /** When we last phoned this shop and nobody picked up, or null. */
  lastNoAnswerAt: string | null;
  /** How many times that has happened on this order. */
  noAnswerCount: number;
  /** First time each stage was reached; null = never. Mirrors CandidateEngagement.at. */
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  signedInAt: string | null;
}

/** A shop that has NOT worked with us yet, in the words the operator uses. */
export function isColdLead(lifecycleStage: string): boolean {
  return lifecycleStage !== "production";
}

/**
 * How far this candidate got with the offer. Higher = warmer = better call,
 * because there is something concrete to ask them about.
 *
 * A `declined` shop scores below every silent one no matter how far they got:
 * they have already given us an answer, so they are the last resort rather
 * than the first call.
 */
export function warmth(c: CallCandidate): number {
  if (c.status === "declined") return -1;
  if (c.signedInAt) return 4;
  if (c.clickedAt) return 3;
  if (c.openedAt) return 2;
  if (c.deliveredAt) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Calling back after nobody picked up
// ---------------------------------------------------------------------------

/**
 * How long to leave a shop alone after they did not answer.
 *
 * The tiers are the offer window's tiers (lib/reachout.ts::
 * suggestedTimeoutMinutes: 6h / 24h / 72h by delivery lead), because the
 * judgement is the same one — how much time is there to be patient with. A
 * rush order gets rung back inside ten minutes; an order four days out is left
 * for two hours rather than pestered.
 *
 * These are minutes, deliberately small and deliberately not a setting yet: a
 * number nobody has calibrated should not arrive with a settings row implying
 * somebody did. Move it to app_settings once the desk has an opinion.
 */
export interface CallBackGaps {
  rush: number;
  sameday: number;
  standard: number;
  far: number;
  noDate: number;
}

/** The shipped ladder, and the fallback whenever a settings row is missing or
 *  a single column is null — the same per-field degradation the offer windows
 *  use, so a half-written settings row cannot collapse a gap to zero and turn
 *  the cooldown off silently. */
export const CALL_BACK_GAP_MIN: CallBackGaps = { rush: 10, sameday: 20, standard: 45, far: 120, noDate: 45 };

export function callBackGapMinutes(
  deliveryAt: string | null | undefined,
  gaps: Partial<CallBackGaps> | null | undefined = CALL_BACK_GAP_MIN,
  now: number = Date.now(),
): number {
  const g = {
    rush: gaps?.rush ?? CALL_BACK_GAP_MIN.rush,
    sameday: gaps?.sameday ?? CALL_BACK_GAP_MIN.sameday,
    standard: gaps?.standard ?? CALL_BACK_GAP_MIN.standard,
    far: gaps?.far ?? CALL_BACK_GAP_MIN.far,
    noDate: gaps?.noDate ?? CALL_BACK_GAP_MIN.noDate,
  };
  if (!deliveryAt) return g.noDate;
  const ms = new Date(deliveryAt).getTime();
  if (Number.isNaN(ms)) return g.noDate;
  const hours = (ms - now) / 3600e3;
  if (hours <= 6) return g.rush;
  if (hours <= 24) return g.sameday;
  if (hours <= 72) return g.standard;
  return g.far;
}

/** Have we rung this shop too recently to ring again? */
export function inCallCooldown(
  c: Pick<CallCandidate, "lastNoAnswerAt">,
  deliveryAt: string | null | undefined,
  gaps: Partial<CallBackGaps> | null | undefined = CALL_BACK_GAP_MIN,
  now: number = Date.now(),
): boolean {
  if (!c.lastNoAnswerAt) return false;
  const at = new Date(c.lastNoAnswerAt).getTime();
  if (Number.isNaN(at)) return false;
  return now - at < callBackGapMinutes(deliveryAt, gaps, now) * 60_000;
}

/**
 * "You called 20 minutes ago — nobody answered." Null when we never have.
 *
 * The operator on the card may not be the operator who rang. Before this, a
 * second person picked up the same number with no idea it had just been tried,
 * because `no_answer` wrote nothing at all.
 */
export function lastCallLine(c: Pick<CallCandidate, "lastNoAnswerAt" | "noAnswerCount">, now: number = Date.now()): string | null {
  if (!c.lastNoAnswerAt) return null;
  const at = new Date(c.lastNoAnswerAt).getTime();
  if (Number.isNaN(at)) return null;
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  const when = mins < 1 ? "just now" : mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"} ago` : (() => {
    const h = Math.round(mins / 60);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  })();
  const times = c.noAnswerCount > 1 ? ` This is call ${c.noAnswerCount + 1}.` : "";
  return `You called ${when} — nobody answered.${times}`;
}

/**
 * The only shops there is any point phoning: the ones we actually asked, who
 * have not answered either way. Limbo.
 *
 * `sent` and `opened` are a live offer nobody has replied to. `expired` is the
 * same silence after the offer lapsed, and is the bulk of this list — a shop
 * worth a call is usually one whose offer timed out. `accepted`/`delivered`
 * are here because they hold the order: pickSubject puts a holder on the card
 * unconditionally, and that call is "how is it going", not "will you take it".
 *
 * Deliberately absent:
 *   candidate/queued — we have never contacted them. There is no offer to ring
 *                      about, and the operator cannot introduce one by phone.
 *   declined         — THEY HAVE ALREADY SAID NO. Ringing a shop back to ask
 *                      again is the one call that should never be suggested,
 *                      and it is worse now that the price is fixed: there is
 *                      no lever left to change their mind with, so the call
 *                      can only annoy them.
 *   reassigned/released — we took the offer back. Not their answer to give.
 */
export const CALLABLE_STATUSES: AssignmentStatus[] = [
  "sent", "opened", "expired", "accepted", "delivered",
];

/** Is this shop one the operator could usefully phone about this order? */
export function isCallTarget(c: Pick<CallCandidate, "status" | "withdrawnAt">): boolean {
  return !c.withdrawnAt && CALLABLE_STATUSES.includes(c.status);
}

/**
 * Who to call, best first.
 *
 * Only shops in limbo (see isCallTarget) — asked, and silent since. Warmth
 * decides the order, then distance (closer is likelier to say yes), then the
 * original match rank as a stable tiebreak so the list never shuffles between
 * two renders.
 *
 * A shop with no phone number still appears — the card shows WHY it cannot be
 * called rather than silently dropping it, which would leave the operator
 * wondering where a candidate went. A shop that declined does NOT: that is not
 * a gap in the list, it is the answer.
 */
export function rankCallTargets(
  candidates: CallCandidate[],
  /** Pass the order's delivery time to apply the call-back cooldown; it sets
   *  how long a shop stays down after not answering. OMITTING THE OPTIONS
   *  ENTIRELY disables the cooldown — an object with `deliveryAt: null` does
   *  not, it means "this order has no delivery date", which still earns a gap.
   *  The two must stay distinguishable: a caller that has not been taught about
   *  cooldowns should get exactly the old ordering. */
  opts?: { deliveryAt: string | null; gaps?: Partial<CallBackGaps> | null; now?: number },
): CallCandidate[] {
  const now = opts?.now ?? Date.now();
  return candidates
    .filter(isCallTarget)
    .slice()
    .sort((a, b) => {
      // A shop we rang minutes ago sorts BELOW one nobody has tried, whatever
      // its warmth. Not filtered out: if every shop is on cooldown the operator
      // still gets the best one, with the card telling them when it was last
      // rung — an empty screen would be a worse answer than a judgement call.
      const ca = opts && inCallCooldown(a, opts.deliveryAt, opts.gaps, now) ? 1 : 0;
      const cb = opts && inCallCooldown(b, opts.deliveryAt, opts.gaps, now) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      const w = warmth(b) - warmth(a);
      if (w !== 0) return w;
      const ad = a.distanceKm ?? Number.POSITIVE_INFINITY;
      const bd = b.distanceKm ?? Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY);
    });
}

/**
 * The shop the card is about.
 *
 * Once somebody has accepted, THEY are the subject regardless of warmth — the
 * call is no longer "will you take it" but "how is it going", and putting a
 * colder candidate on the card at that point would be actively misleading.
 * Otherwise it is the operator's explicit pick (?shop=), else the warmest.
 */
export function pickSubject(
  ranked: CallCandidate[],
  requestedAssignmentId?: string | null,
): CallCandidate | null {
  if (ranked.length === 0) return null;
  const holder = ranked.find((c) => c.status === "accepted" || c.status === "delivered");
  if (holder) return holder;
  if (requestedAssignmentId) {
    const picked = ranked.find((c) => c.assignmentId === requestedAssignmentId);
    if (picked) return picked;
  }
  return ranked[0];
}

/**
 * Why there is nobody on the card, in the operator's words.
 *
 * Two very different situations both end up with an empty list, and telling
 * them apart is the whole point: "we have not asked anyone yet" is work waiting
 * to start, while "everyone we asked said no" is a dead end that needs the next
 * wave of shops. Before declined shops were filtered out of the list, the
 * second case never arose — the card just showed a shop that had already
 * refused, which read as "call them".
 *
 * Takes the RAW assignment statuses for the order (including withdrawn), so it
 * can describe what happened rather than what survived the filter.
 */
export function noSubjectReason(statuses: AssignmentStatus[]): string {
  const declined = statuses.filter((s) => s === "declined").length;
  if (declined > 0) {
    return declined === 1
      ? "The one shop we asked has turned this order down. There is nobody left to phone about it — this order needs a new shop found for it."
      : `All ${declined} shops we asked have turned this order down. There is nobody left to phone about it — this order needs new shops found for it.`;
  }
  if (statuses.length > 0) {
    return "No shop has been sent this offer yet, so there is nothing to phone anybody about. The offer has to go out first.";
  }
  return "No shop has been offered this order, so there is no one on the other end of a phone.";
}

/** The next shop to try after this one, or null at the end of the list. */
export function nextAfter(ranked: CallCandidate[], currentAssignmentId: string): CallCandidate | null {
  const i = ranked.findIndex((c) => c.assignmentId === currentAssignmentId);
  if (i < 0 || i + 1 >= ranked.length) return null;
  return ranked[i + 1];
}

// ---------------------------------------------------------------------------
// History with us
// ---------------------------------------------------------------------------

/** One past assignment for the same florist, across all orders. */
export interface HistoryRow {
  assignmentId: string;
  orderId: string;
  orderName: string | null;
  status: AssignmentStatus;
  declineReason: string | null;
  declineDetail: string | null;
  declinedAt: string | null;
  deliveredAt: string | null;
}

export interface FloristHistory {
  /** Orders this shop actually delivered for us. */
  completed: number;
  /** Times they actively turned an order down, newest first. */
  refusals: { when: string | null; reason: string | null; detail: string | null; orderId: string; orderName: string | null }[];
}

/**
 * What this shop has done with us — completed orders and refusals only.
 *
 * AN OFFER THAT LAPSED IS NOT A REFUSAL and never appears here. Silence means
 * nobody was at the keyboard; counting it as a "no" would make every busy shop
 * look like it had rejected us repeatedly and would poison the one number on
 * this card that is supposed to mean something. Only a decline the shop
 * actively made counts, whether or not they gave a reason for it.
 */
export function buildHistory(rows: HistoryRow[]): FloristHistory {
  const completed = rows.filter((r) => r.status === "delivered").length;
  const refusals = rows
    .filter((r) => r.status === "declined")
    .sort((a, b) => String(b.declinedAt ?? "").localeCompare(String(a.declinedAt ?? "")))
    .map((r) => ({
      when: r.declinedAt,
      reason: r.declineReason,
      detail: r.declineDetail,
      orderId: r.orderId,
      orderName: r.orderName,
    }));
  return { completed, refusals };
}

/** "No completed orders · 1 refusal" — the one-line relationship summary. */
export function historySummary(h: FloristHistory): string {
  const left = h.completed === 0
    ? "No completed orders"
    : `${h.completed} completed order${h.completed === 1 ? "" : "s"}`;
  const right = h.refusals.length === 0
    ? "no refusals"
    : `${h.refusals.length} refusal${h.refusals.length === 1 ? "" : "s"}`;
  return `${left} · ${right}`;
}

// ---------------------------------------------------------------------------
// What they did with THIS offer
// ---------------------------------------------------------------------------

export type OfferSignal = "declined" | "signed_in" | "clicked" | "opened" | "delivered" | "sent" | "unsent";

export function offerSignal(c: CallCandidate): OfferSignal {
  if (c.status === "declined") return "declined";
  if (c.signedInAt) return "signed_in";
  if (c.clickedAt) return "clicked";
  if (c.openedAt) return "opened";
  if (c.deliveredAt) return "delivered";
  if (c.sentAt) return "sent";
  return "unsent";
}

/**
 * One sentence of fact about this offer. Statement, never instruction: the
 * screen reports what happened and leaves the call to the person making it.
 *
 * `fmt` renders a timestamp however the caller wants it (the page passes a
 * locale-aware short format); it is a parameter so this stays pure.
 */
export function offerLine(c: CallCandidate, fmt: (iso: string) => string): string {
  switch (offerSignal(c)) {
    case "declined":
      return c.declineReason
        ? `Turned this order down${c.declinedAt ? ` on ${fmt(c.declinedAt)}` : ""} — “${c.declineReason}”.`
        : `Turned this order down${c.declinedAt ? ` on ${fmt(c.declinedAt)}` : ""}, without giving a reason.`;
    case "signed_in":
      return `Opened the offer and signed in to it on ${fmt(c.signedInAt!)}. Never answered.`;
    case "clicked":
      return `Opened the offer and clicked through to it on ${fmt(c.clickedAt!)}. Never answered.`;
    case "opened":
      return `Opened the offer on ${fmt(c.openedAt!)}, but never clicked through and never answered.`;
    case "delivered":
      return `The offer reached them on ${fmt(c.deliveredAt!)}. They have not opened it.`;
    case "sent":
      // Engagement carries no bounce signal, so this covers both "the provider
      // never confirmed delivery" and "it bounced". Both mean the same thing to
      // the operator: assume they have not seen it.
      return `Sent on ${fmt(c.sentAt!)}, with no confirmation it arrived. Assume they have not seen it.`;
    default:
      return "No offer has been sent to this shop yet.";
  }
}

/** Why this shop cannot be called, or null when it can. */
export function uncallableReason(c: CallCandidate): string | null {
  if (!c.phone) return "No phone number on file for this shop.";
  return null;
}

// ---------------------------------------------------------------------------
// Recording the call
// ---------------------------------------------------------------------------

/**
 * The six reasons a shop gives for saying no.
 *
 * These are EXACTLY the codes the florist-facing decline buttons already write
 * (components/florist/FloristOrderDetail.tsx::REASONS) and they land in the
 * same `order_assignments.decline_reason` column. Keep the two lists identical
 * — a call-sourced decline and a self-service one have to stay comparable, or
 * lib/opsStats.ts::bucketDeclineReasons starts counting the same objection
 * under two names.
 */
export const CALL_DECLINE_REASONS = [
  "Price too low",
  "Too busy",
  "Out of area",
  "Can't source",
  "Too urgent",
  "On holiday",
] as const;

export type CallOutcome = "accepted" | "refused" | "no_answer";

/** Assignment statuses a decline can still be written to — mirrors the
 *  OPEN_STATUSES guard in app/api/orders/reachout/route.ts. Anything else
 *  (an offer that already lapsed, the usual case for a shop worth phoning) is
 *  logged as a call outcome without touching the assignment's status. */
export const DECLINABLE_STATUSES: AssignmentStatus[] = ["candidate", "queued", "sent", "opened"];

/**
 * Assignment statuses a refusal taken ON THE PHONE can be written to.
 *
 * `DECLINABLE_STATUSES` above is the reachout route's guard and is left exactly
 * as it is — a self-service decline arriving for an offer that already lapsed
 * IS a race, and should still lose. This set is the call screen's, and the one
 * status it adds is the whole point.
 *
 * `expired` — a lapsed offer — is the usual case for a shop worth phoning; the
 * call screen exists for that population. It used to be excluded here, copied
 * across from the reachout guard rather than re-derived for a human who has
 * just been told "no" out loud. The refusal went to an `order_events` row and
 * nowhere else, and every reader downstream looks at the assignment: the call
 * list kept offering the same shop (it filters on status, and `expired` is
 * callable), "History with us" still read "no refusals", the Operator row
 * still said "none replied", and the reason the operator typed never reached
 * opsStats. The operator's twenty seconds left no trace anyone could see.
 *
 * Overwriting `expired` with `declined` loses nothing that matters: the
 * `offer_expired` event is already in the trail, and the `call_refused` event
 * records the prior `assignment_status` explicitly. It does not shut the shop
 * out either — lateAccept.ts::ACCEPTABLE_ASSIGNMENT_STATUSES admits `declined`
 * deliberately, so a change of mind can still be accepted from their email.
 * Once a shop has said no on the phone, `declined` is simply the truer word.
 */
export const CALL_DECLINABLE_STATUSES: AssignmentStatus[] = [...DECLINABLE_STATUSES, "expired"];

export function canDeclineInPlace(status: AssignmentStatus): boolean {
  return CALL_DECLINABLE_STATUSES.includes(status);
}
