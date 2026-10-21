// Daily automation digest: the funnel, as pure functions.
//
// THE QUESTION THIS ANSWERS
//
// CX puts orders into the working set. Of those, how many did the loop carry to
// a delivered flower without anyone touching it? The ideal reads 5 in, 5
// automatic, 5 delivered. Everything here exists to show how far from that we
// are, and where the drop-off is.
//
// THE DENOMINATOR IS WHAT CX TOOK ON, not orders received.
//
// An earlier version counted every order that arrived (~34/day) against the
// handful the loop touched (~3), which produced numbers nobody could read: the
// gate deliberately ignores almost everything, so "received" was pure noise.
//
// An order becomes ours the first time CX either picks it for the working set
// (`worklist_added`) OR acts on it directly. The second arm is not optional:
// on 2026-08-20 the only order CX handled (#2000030, where one staff member
// added a florist, escalated, resolved and sent outreach) was never added to
// the working set, so a worklist-only denominator reported that whole day as
// empty. Each order is counted ONCE, in the period it first became ours.
//
// ADDING TO THE WORKING SET IS NOT AN INTERVENTION.
//
// `worklist_added` is a staff action, so counting it as a human touch would
// score every order "needed a human" and the automation rate would be 0% by
// construction. The pick is the ENTRY CONDITION, not a rescue. So
// `worklist_added`/`worklist_removed` are excluded from staff-touch detection,
// and only events at or after the moment the order entered are considered.
//
// WHO COUNTS AS A HUMAN
//
//   `system` / `system:*` / null   -> the automation acted on its own.
//   an address in `allowed_emails` -> one of OUR staff stepped in.
//   any other address              -> the FLORIST acted.
//
// A florist accepting an offer or uploading a photo is the loop working as
// designed, so it does NOT count as intervention. Only Facundo staff do.
//
// AUTOMATION IS MEASURED POSITIVELY, AND NAMED.
//
// This file used to answer "how much did the loop do?" with `!staffTouched`,
// which is a NEGATION: an order that entered the working set and then received
// no events at all satisfied it, so doing nothing scored as automation. Over 11
// to 26 Aug 2026 that reported 8 of 46 orders as hands-off when 6 of those 8
// had zero progress events; on 11 Aug alone it printed 67% for a day whose four
// "successes" never moved. `reachedAlone` replaces it: a stage only counts when
// the loop actually got the order there.
//
// The result is reported as a STAGE NAME, not a share and not a mean. See
// digestStages.ts for why.

import {
  furthest,
  passedThrough,
  stageIndex,
  type StageId,
} from "./digestStages";

/** Staff bookkeeping that must never count as intervention. See header. */
export const WORKING_SET_EVENT_TYPES = new Set(["worklist_added", "worklist_removed"]);

export interface DigestPeriod {
  /** Inclusive first local day, `YYYY-MM-DD`. */
  fromDay: string;
  /** Inclusive last local day, `YYYY-MM-DD`. */
  toDay: string;
  timezone: string;
}

/** One order that entered the working set during the period, plus its outcome. */
export interface OrderOutcome {
  orderId: string;
  /** `orders.status` right now. */
  status: string;
  /** True when a Facundo staff member acted on it after it entered. */
  staffTouched: boolean;
  /** Furthest stage it reached, by anyone. */
  reached: StageId;
  /** Furthest stage the loop carried it to with no staff involvement. */
  reachedAlone: StageId;
  /** How many things a staff member did to it after it entered. */
  staffActions: number;
  /**
   * Why no offer ever went out, for an order that got no further than Matched.
   * Null on every other order, including ones that did get an offer.
   *
   * This is the question CX actually asks the digest: on 2026-08-27 six of the
   * eight orders taken on stopped at Matched, and the mail said only that they
   * stopped. Derived in dailyDigest.ts from the candidate florists, never
   * stored, so it cannot go stale.
   */
  noOfferReason: NoOfferReason | null;
  /** Best known delivery instant, or null when it has not been delivered. */
  deliveredAt: string | null;
  /** Requested delivery date from Shopify, or null when absent. */
  dueAt: string | null;
  /** How many florists were ever lined up for it. */
  candidates: number;
  expired: number;
  declined: number;
}

export interface EscalationReason {
  reason: string;
  count: number;
}

/**
 * Why an order that was matched never had an offer sent.
 *
 *   newShopsOnly  every florist we lined up is OUTSIDE the network, and
 *                 dashboard/lib/waves.ts will not send to those unattended, so
 *                 the order sits until a person sends it by hand.
 *   notSentYet    at least one network shop was lined up, so the wave engine
 *                 was allowed to send and simply has not yet.
 *   other         it is off the happy path (escalated), so a person owns it.
 *
 * The three are exhaustive over orders whose furthest stage is Matched, which
 * is what lets the block under the funnel add up to the funnel's own drop.
 */
export type NoOfferReason = "newShopsOnly" | "notSentYet" | "other";

/** The `noOfferReason` tally, plus the total it must equal. */
export interface NoOfferBreakdown {
  newShopsOnly: number;
  notSentYet: number;
  other: number;
  /** Orders whose furthest stage was Matched. The three counts sum to this. */
  total: number;
}

/**
 * One side of the offer split: shops we had already signed, or brand new ones.
 *
 * A COHORT, NOT A CALENDAR. All three numbers describe the SAME set of offers,
 * the ones sent in the period, so `accepted <= answered <= offersSent` always
 * holds and a share of them can never exceed 100%.
 *
 * The previous shape counted offers by their send date and replies by their
 * reply date, which are different sets. A florist answering on 2026-08-27 an
 * offer we sent days earlier printed "Accepted 1 (n/a)" against 0 sent, and the
 * 7-day version printed "8 of 6 (133%)". Both were read as bugs by CX, and both
 * were the same modelling mistake. `shops` went at the same time: it was the
 * count of distinct florists offered, which on almost every day equals
 * `offersSent` exactly, so it read as the same number printed twice.
 */
export interface CohortActivity {
  /** Offers sent in the period. */
  offersSent: number;
  /** Of THOSE offers, how many have been answered, accepted or refused. */
  answered: number;
  /** Of THOSE offers, how many were accepted. */
  accepted: number;
  /**
   * Of THOSE offers, how many simply ran out of time — the window closed and
   * the shop never replied either way.
   *
   * Separated from "not accepted" because the two call for opposite responses.
   * A refusal is a shop that read the offer and said no; a timeout may be a shop
   * that never had a chance to read it at all. If most of a day's offers land
   * here, the suspect is the RESPONSE WINDOW, not the florists — and that
   * failure is otherwise invisible, because a shop that never saw an offer looks
   * exactly like a shop that ignored one.
   *
   * Measured after a run where an order burned nine shops in forty minutes with
   * seven offers expiring unread, and nothing in the product said so.
   */
  timedOut: number;
}

export const EMPTY_COHORT: CohortActivity = { offersSent: 0, answered: 0, accepted: 0, timedOut: 0 };

/**
 * Offer activity IN the period, split by who the florist is.
 *
 * These answer a different question from the funnel and are counted on a
 * different basis: the funnel follows the orders CX took on, while this counts
 * what happened on the wire that day. An offer sent last week and accepted
 * yesterday counts in yesterday's `accepted`.
 *
 * THE SPLIT IS THE POINT. Aggregated, 664 offers between 24 Jul and 26 Aug 2026
 * read as a 2.1% acceptance rate. Split, it is 39.1% to the 12 shops already in
 * the network and 0.8% to the 555 strangers, which are two different businesses
 * averaged into one meaningless number. The cut is `lifecycle_stage` in
 * production/onboarding, deliberately the SAME condition
 * `dashboard/lib/waves.ts` uses to decide whether the wave engine may send an
 * offer unattended, so the metric and the behaviour cannot drift apart.
 */
export interface ActivityStats {
  /** Shops that had already joined when the offer went out. */
  network: CohortActivity;
  /** Shops being contacted for the first time. */
  newShops: CohortActivity;
  /**
   * Why florists said no, counted on the day they SAID it, not the day we
   * asked. Deliberately still a reply-date tally: it is a list of reasons, not
   * a rate, so it has no denominator to be wrong about, and a refusal is worth
   * reading on the day it lands whatever day the offer went out.
   */
  refusalReasons: EscalationReason[];
}

/** How far the loop got on its own, and how far the orders got with our help. */
export interface AutomationReport {
  /** Furthest stage reached with no staff involvement, and how many got there. */
  alone: { stage: StageId; count: number };
  /** Furthest stage reached at all, and how many got there. */
  reached: { stage: StageId; count: number };
  /** Orders the loop moved past Created on its own. */
  movedAlone: number;
  /** Orders that never left Created: nothing at all happened to them. */
  neverMoved: number;
  /** Orders that passed THROUGH each stage, in STAGES order. */
  passedThrough: number[];
  /**
   * Of those, how many got there with NO staff involvement, in STAGES order.
   * Always `<= passedThrough` at the same index, so the difference is the
   * manual work and the two can be drawn as one bar in two colours.
   */
  passedThroughAlone: number[];
}

export interface DigestReport {
  period: DigestPeriod;
  activity: ActivityStats;
  /** A provider whose ACCOUNT failed during the period (not one bad
   * recipient). Empty on a normal day. See providerOutages. */
  providerOutages?: ProviderOutage[];

  // ---- The funnel -------------------------------------------------------
  /** Orders CX took on during the period, by picking or by handling. */
  takenIn: number;
  /** Of those, how many a florist accepted. */
  accepted: number;
  /** Of those, how many reached a delivered flower. */
  delivered: number;
  automation: AutomationReport;
  /** Why the orders that stopped at Matched never had an offer sent. */
  noOffer: NoOfferBreakdown;

  // ---- Delivery quality -------------------------------------------------
  onTime: number;
  late: number;
  /** Delivered, but we cannot say whether it was on time. Never guessed. */
  timingUnknown: number;

  // ---- Where the rest went ---------------------------------------------
  inProgress: number;
  escalated: number;
  escalationReasons: EscalationReason[];
  cancelled: number;
  /** Closed in Shopify without our loop delivering it (fulfilled elsewhere). */
  closedUpstream: number;

}

/** Maps an instant to its calendar day in `timeZone`. Reused per event. */
export function localDayMapper(timeZone: string): (iso: string) => string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return (iso: string) => fmt.format(new Date(iso));
}

export function addDays(dayIso: string, delta: number): string {
  const [y, m, d] = dayIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Today's calendar date in `timeZone`. */
export function localToday(now: Date, timeZone: string): string {
  return localDayMapper(timeZone)(now.toISOString());
}

/** The local hour (0-23) in `timeZone`. */
export function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", hour12: false,
  }).format(now)) % 24;
}

/** Day of week for a `YYYY-MM-DD`, 0 = Sunday. Pure date maths, no zone. */
export function dayOfWeek(dayIso: string): number {
  const [y, m, d] = dayIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Which days a run on `now` should report on, or null when it should not send.
 *
 * Nothing goes out at the weekend, because nobody reads it. Monday therefore
 * covers Friday, Saturday AND Sunday rather than Sunday alone: without that,
 * two days of the funnel would simply never be reported. Tuesday to Friday
 * cover the previous day.
 */
export function reportingPeriod(now: Date, timeZone: string): DigestPeriod | null {
  const today = localToday(now, timeZone);
  const weekday = dayOfWeek(today);

  if (weekday === 6 || weekday === 0) return null; // Saturday, Sunday
  if (weekday === 1) {
    // Monday: Friday through Sunday.
    return { fromDay: addDays(today, -3), toDay: addDays(today, -1), timezone: timeZone };
  }
  const yesterday = addDays(today, -1);
  return { fromDay: yesterday, toDay: yesterday, timezone: timeZone };
}

/**
 * Derives WHY an order escalated, from the state of its offers.
 *
 * There is no stored reason to read. Only three `escalated` events exist in the
 * whole database and two of them are demo rows, while 26 orders sit at
 * `status='escalated'` with no event at all -- the status gets set without one
 * being written. Rather than print an empty column or invent a value, the
 * reason is derived from what actually happened to the offers, which is real
 * state. Every currently-escalated order in production has zero candidates, so
 * "No florist found nearby" is the honest answer for all of them today.
 */
export function escalationReason(o: OrderOutcome): string {
  if (o.candidates === 0) return "No florist found nearby";
  if (o.expired === o.candidates) return "No florist answered";
  if (o.declined === o.candidates) return "Every florist declined";
  return "Stalled part-way";
}

function isDelivered(status: string): boolean {
  return status === "delivered" || status === "paid";
}

/** Tallies the outcomes into the report. */
export function buildReport(args: {
  period: DigestPeriod;
  outcomes: OrderOutcome[];
  activity: ActivityStats;
  providerFailures?: ProviderFailureRow[];
}): DigestReport {
  const { period, outcomes } = args;
  const toDay = localDayMapper(period.timezone);

  let delivered = 0;
  let accepted = 0;
  let onTime = 0;
  let late = 0;
  let timingUnknown = 0;
  let escalated = 0;
  let cancelled = 0;
  let closedUpstream = 0;
  let inProgress = 0;
  const reasons = new Map<string, number>();
  const noOffer: NoOfferBreakdown = { newShopsOnly: 0, notSentYet: 0, other: 0, total: 0 };

  for (const o of outcomes) {
    if (o.reached === "matched") {
      noOffer.total++;
      // Defaults to `other` rather than dropping the order: the three buckets
      // have to sum to the funnel's drop, so an outcome with no reason still
      // has to land somewhere countable.
      noOffer[o.noOfferReason ?? "other"]++;
    }
    if (stageIndex(o.reached) >= stageIndex("fulfilment")) accepted++;

    if (isDelivered(o.status)) {
      delivered++;
      // Both dates are needed to judge timeliness. `delivered_at` on the
      // assignment is usually null in production -- the reliable stamp is the
      // delivered_photo event -- and the caller coalesces the two. When either
      // side is still missing it is reported as unknown, never assumed on time.
      if (o.deliveredAt && o.dueAt) {
        if (toDay(o.deliveredAt) <= toDay(o.dueAt)) onTime++;
        else late++;
      } else {
        timingUnknown++;
      }
    } else if (o.status === "escalated") {
      escalated++;
      const reason = escalationReason(o);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    } else if (o.status === "cancelled") {
      cancelled++;
    } else if (o.status === "closed") {
      // Closed in Shopify without our loop delivering it. Usually means it was
      // fulfilled some other way. Kept as its own bucket rather than folded
      // into a failure count, because it is not the loop breaking.
      closedUpstream++;
    } else {
      inProgress++;
    }
  }

  const reachedStages = outcomes.map((o) => o.reached);
  const aloneStages = outcomes.map((o) => o.reachedAlone);

  return {
    period,
    activity: args.activity,
    takenIn: outcomes.length,
    accepted,
    delivered,
    automation: {
      alone: furthest(aloneStages),
      reached: furthest(reachedStages),
      movedAlone: aloneStages.filter((s) => stageIndex(s) > 0).length,
      neverMoved: reachedStages.filter((s) => stageIndex(s) === 0).length,
      passedThrough: passedThrough(reachedStages),
      passedThroughAlone: passedThrough(aloneStages),
    },
    noOffer,
    onTime,
    late,
    timingUnknown,
    inProgress,
    escalated,
    escalationReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    cancelled,
    closedUpstream,
    providerOutages: providerOutages(args.providerFailures ?? []),
  };
}

// ---------------------------------------------------------------------------
// Provider outages — an ACCOUNT-level failure, as opposed to one bad recipient.
//
// WHY THIS IS IN THE DIGEST: between 2026-08-07 and 2026-09-11 the Telnyx
// account was deactivated on and off ("your account has been deactivated. It
// may be out of funds.") and 228 texts failed. Nobody noticed for five weeks.
// Every failure WAS recorded in external_ops; nothing read it. The CX alert
// sweep could not have caught it either: it is order-scoped, and in production
// its email leg is disabled in settings and no staff device is subscribed to
// push, so on 2026-09-16 it had skipped all 1,408 of its last-14-day alerts.
// The digest is the one automated message proven to reach a person every day,
// so this is where an outage gets said out loud.
//
// Only the provider's own "your account is down" signature counts. A single
// rejected number ("Invalid destination number", "destination is not mobile")
// is about that florist, not about us, and must never read as an outage.
// ---------------------------------------------------------------------------

export interface ProviderFailureRow {
  provider: string;
  error: string | null;
  created_at: string;
}

export interface ProviderOutage {
  provider: string;
  /** What stopped working, in words the reader uses: "SMS". */
  channel: string;
  failures: number;
  firstAt: string;
  lastAt: string;
}

const ACCOUNT_DOWN_SIGNATURES: { provider: string; channel: string; match: RegExp }[] = [
  // The exact wording Telnyx returned, HTTP 403, 228 times in production.
  { provider: "telnyx", channel: "SMS", match: /account has been deactivated/i },
];

export function providerOutages(rows: ProviderFailureRow[]): ProviderOutage[] {
  const found = new Map<string, ProviderOutage>();
  for (const row of rows) {
    const sig = ACCOUNT_DOWN_SIGNATURES.find(
      (s) => s.provider === row.provider && row.error != null && s.match.test(row.error),
    );
    if (!sig) continue;
    const prev = found.get(sig.provider);
    if (!prev) {
      found.set(sig.provider, { provider: sig.provider, channel: sig.channel, failures: 1, firstAt: row.created_at, lastAt: row.created_at });
    } else {
      prev.failures += 1;
      if (row.created_at < prev.firstAt) prev.firstAt = row.created_at;
      if (row.created_at > prev.lastAt) prev.lastAt = row.created_at;
    }
  }
  return [...found.values()].sort((a, b) => b.failures - a.failures);
}
