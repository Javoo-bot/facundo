// The Operator panel's language layer.
//
// `lib/cxAttention.ts` already decides WHICH orders need a human and how urgent
// each one is. It says so in our own vocabulary though — "Offer stalling — SLA
// breached", "wave_ceiling", "70% held — tier-hold" — which is exactly the
// vocabulary a new CX operator does not have on their first Monday.
//
// This file is the translation, and nothing else: one CxReason in, one
// headline + one button label out. It is deliberately pure and import-light
// (types only) so `lib/operator.test.mjs` can cover every branch without a
// Next.js build or a Supabase client.
//
// The rule for the copy: the headline says what is TRUE, the action says what
// WILL HAPPEN when you click. Neither mentions a status, a table, or a percent
// sign. If you add a new CxReason in cxAttention.ts, add its line here too —
// the fallbacks below keep the page honest, but they are vaguer than they
// should be, and the test asserts every known label is mapped explicitly.

import type { CxCategory, CxReason } from "./cxAttentionRules";

export interface OperatorAction {
  /** Plain sentence for the row — what is wrong, in words a new hire reads once. */
  headline: string;
  /** The button. Says what happens next, in the imperative. */
  action: string;
  /** Optional `#anchor` on the order page to land the operator in the right place. */
  anchor?: string;
  /** Run in place instead of navigating: the panel POSTs, the row re-renders,
   *  and the operator stays on the queue.
   *
   *  Only for actions that are one unambiguous server call. The decision has
   *  already been made somewhere else — the approval carries the drafted email,
   *  the payout hold carries the amount — so the panel's job is a yes, not a
   *  form. Anything that needs the operator to WRITE something (a reply) or to
   *  JUDGE something they cannot see on the row (which shop to phone) keeps its
   *  own screen. */
  run?: "rematch" | "approve" | "payout";
  /** Send the operator to a screen built for this one job instead of to the
   *  order page:
   *    "call"  — /orders/[id]/call, the shop, its number and the three outcomes
   *    "reply" — /orders/[id]/reply, the florist's question and a box to answer
   *  Both replaced an anchor onto the order page, where the right card sat
   *  among thirteen others. */
  route?: "call" | "reply";
}

/** Deadline urgency, and the colour that goes with it. */
export type OperatorSeverity = "crit" | "warn" | "calm";

// ── Reason → plain English ─────────────────────────────────────────────────
//
// Exact labels first (these are the string constants in cxAttention.ts and
// cxAttentionRules.ts). Anything parameterised — a held percentage, a dispute
// status, an escalation reason in brackets — is matched by prefix below.
const EXACT: Record<string, OperatorAction> = {
  // Placing the order (cxAttentionRules.ts::placementAttentionReason)
  "Out of time — place this now": { headline: "No time left to find a shop", action: "Place with a florist" },
  "Past the delivery deadline": { headline: "The delivery deadline has passed", action: "Place with a florist" },
  "Florist went dark, nobody left to hand it to": { headline: "The florist stopped replying", action: "Find a florist", run: "rematch" },
  "No florist left in range — escalated": { headline: "No florist available in range", action: "Find a florist", run: "rematch" },
  "No florist found — escalated": { headline: "No florist found for this address", action: "Find a florist", run: "rematch" },
  // SILENCE, NOT REFUSAL. This reason is `wave_ceiling`: we ran the wave budget
  // out and nobody replied. It used to read "Every shop we asked said no", which
  // is the opposite of what happened and has an operational cost — the desk
  // never phones a shop that refused, so an operator reading that concluded
  // there was nobody left to ring when in fact every one of them was still
  // callable. Measured on a France run (2026-09-03) with five expired offers
  // and zero declines.
  "No answer after every wave — untried shops remain": { headline: "No answer from any shop we asked", action: "Send to another florist" },
  "Awaiting reach-out": { headline: "Nobody has been asked yet", action: "Start contacting florists" },

  // Offers (cxAttention.ts rules 2 and 2b)
  // The one row that is literally a phone call: an offer is out, its SLA has
  // passed, and somebody has to ring the shop. Goes to the call card rather
  // than the order page — this is the "button lands on the order page, not on
  // the control itself" gap in the design doc, closed for this reason.
  "Offer stalling — SLA breached": { headline: "No florist has answered yet", action: "Contact a florist", route: "call" },
  // The last candidate declined OR expired (cxAttention.ts rule 2b), so this one
  // genuinely cannot say which it was. It must therefore claim neither: the only
  // thing that is certainly true is that no offer is live.
  "Needs next florist — no live offer": { headline: "Nobody is being asked right now", action: "Send to another florist" },
  // cxAttention.ts rule 2d. A shop that opened or clicked an expired offer is
  // the warmest lead on the order, so the action is to ring THAT shop before
  // cold-offering anyone new. Order #2000034 is why this exists.
  "A florist opened this offer but never answered": { headline: "A florist looked at this order but didn't reply", action: "Call that florist", route: "call" },

  // Delivery (rule 3)
  "Late — past the delivery window": { headline: "This should have been delivered already", action: "Check with the florist" },
  // AI photo check verdicts (rule 9, cxAttentionRules.ts::photoVerdictAttentionReasons).
  // The payment itself has already gone out either way (lib/payoutHold.ts,
  // since 2026-08-20) — this is purely "go look at the photo", never a
  // payment action, so it keeps the plain "delivery" category copy.
  "AI photo check could not decide — a person should look": { headline: "The delivery photo needs a human look", action: "Check the photo" },
  "AI photo check says this isn't the order — a person should look": { headline: "The delivery photo doesn't look right", action: "Check the photo" },

  // Approvals (cxAttention.ts::APPROVAL_ATTENTION)
  "Approve match — make candidates live": { headline: "A shortlist of florists is ready for you", action: "Approve the shortlist" , run: "approve" },
  "Approve offer to send": { headline: "An offer is ready to send", action: "Approve the offer" , run: "approve" },
  "Approve reassign to next florist": { headline: "Moving this to the next florist needs you", action: "Approve the change" , run: "approve" },
  // The shop accepted and then went quiet — no photo, no sign of work, and the
  // delivery window closing. A photo is the simplest proof of "yes, I have
  // this", so that is what we ask for. The order is NOT taken off them: it is
  // still theirs, and this is the message that lets them keep it.
  "Florist accepted but has not started": { headline: "A florist took this but has not started", action: "Ask florist for a photo", run: "approve" },
  "Approve escalation to CX": { headline: "This is about to be escalated", action: "Approve the escalation" , run: "approve" },
  "Approve Shopify write-back": { headline: "A Shopify update is waiting to be sent", action: "Approve the update" , run: "approve" },
  "Approve customer ‘assigned’ email": { headline: "A customer email is waiting to be sent", action: "Approve the email" , run: "approve" },
  "Approve customer ‘on the way’ email": { headline: "A customer email is waiting to be sent", action: "Approve the email" , run: "approve" },
  "Approve customer ‘delivered’ email": { headline: "A customer email is waiting to be sent", action: "Approve the email" , run: "approve" },
  // cxAttention's own fallback, for an approval kind APPROVAL_ATTENTION has no
  // entry for. Vaguer than the rest by necessity — we genuinely do not know
  // what the step is — but still a sentence, not a code.
  "Approve pending step": { headline: "A step is waiting for your approval", action: "Review it" , run: "approve" },

  // Money (rules 5 and 6)
  "Payout failed": { headline: "The payment to the florist failed", action: "Fix the payment" },
  "Payout stuck — retries exhausted, settle manually": { headline: "The payment never went through", action: "Settle it by hand" },

  // Problems a florist raised on the order (cxAttention rule 4, via
  // lib/i18n/issueLabels.ts::issueLabel — always called with "en" there, so
  // these are the strings that actually arrive). `order_issues.type` is a
  // CLOSED set in the schema, so all six are spelled out: issueLabel's own
  // copy is a noun-phrase chip ("Missing ingredient", "Issue"), which reads
  // fine next to a badge and badly as the one sentence on an operator's row.
  "Missing ingredient": { headline: "The florist is missing an ingredient", action: "Reply to the florist", route: "reply" },
  "Wrong address": { headline: "The delivery address looks wrong", action: "Reply to the florist", route: "reply" },
  "Address out of range": { headline: "The address is outside the florist's range", action: "Reply to the florist", route: "reply" },
  "No one home / recipient unavailable": { headline: "Nobody was home for the delivery", action: "Reply to the florist", route: "reply" },
  "Damaged / wrong recipient": { headline: "The flowers were damaged, or went to the wrong person", action: "Reply to the florist", route: "reply" },
  Issue: { headline: "The florist reported a problem", action: "Reply to the florist", route: "reply" },

  // Placing, continued — the list ran out and nobody looked further
  // (cxAttentionRules.ts, `candidates_exhausted`).
  "The list of shops ran out — nobody looked further": { headline: "The list of shops ran out", action: "Find more florists", run: "rematch" },

  // Shopify conflict (rule 7)
  "Shopify shows this fulfilled — but our florist still holds it": {
    headline: "Shopify says this is done, our florist says it is not",
    action: "Check what happened",
  },
};

// Parameterised labels, matched on their stable opening. Order matters only in
// that the first match wins; these prefixes do not overlap.
const PREFIX: [string, OperatorAction][] = [
  // "70% held — untrusted tier" / "30% held — operator hold switch" …
  ["70% held", { headline: "Payment is waiting for your approval", action: "Approve the payment", run: "payout" }],
  ["30% held", { headline: "Payment is waiting for your approval", action: "Approve the payment", run: "payout" }],
  // "Card dispute (needs_response)"
  ["Card dispute", { headline: "The customer disputed the card payment", action: "Review the dispute" }],
  // "Effect stuck (writeback)"
  ["Effect stuck", { headline: "A step of this order never finished", action: "Settle it by hand" }],
  // "Florist waiting on a reply (out_of_scope)"
  ["Florist waiting on a reply", { headline: "A florist asked a question", action: "Reply to the florist", route: "reply" }],
];

// Last resort, per category. Reached only by an order-issue type from
// lib/i18n/issueLabels.ts (whose set is open — florists can raise new issue
// types without this file changing) or by a reason added upstream and not yet
// translated here. Vague but never wrong, and never blank.
const BY_CATEGORY: Record<CxCategory, OperatorAction> = {
  place: { headline: "This order still has no florist", action: "Find a florist", run: "rematch" },
  approval: { headline: "A step is waiting for your approval", action: "Review it", run: "approve" },
  message: { headline: "The florist reported a problem", action: "Open the message", route: "reply" },
  delivery: { headline: "There is a problem with the delivery", action: "Check with the florist" },
  money: { headline: "There is a problem with the payment", action: "Review the payment" },
};

/** One CxReason → the sentence and the button the Operator panel shows for it. */
export function operatorAction(reason: Pick<CxReason, "category" | "label">): OperatorAction {
  const exact = EXACT[reason.label];
  if (exact) return exact;
  for (const [prefix, action] of PREFIX) {
    if (reason.label.startsWith(prefix)) return action;
  }
  // An order issue raised by a florist: issueLabel() already produced a
  // human sentence for it, so show that rather than the generic fallback —
  // but keep the category's action and anchor.
  if (reason.category === "message") {
    return { ...BY_CATEGORY.message, headline: reason.label };
  }
  return BY_CATEGORY[reason.category];
}

// ── The countdown ──────────────────────────────────────────────────────────
//
// The one number the panel ranks by. Deliberately coarse: minutes under an
// hour, whole hours after that, out to days past two of them. Nobody triaging
// a queue needs "26 h 14 m", and the extra digits cost more than they say.

export interface Countdown {
  /** The number, as a string. "0" when the deadline has passed. */
  value: string;
  /** Its unit — already singular/plural, ready to render. */
  unit: string;
  severity: OperatorSeverity;
  /** True once the deadline is behind us, so the row can say so outright. */
  overdue: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Two hours or less is critical; anything still inside two days is a warning;
 * two days or more is calm. Mirrors the intent of
 * components/orders/orderDerive.ts::deliverySeverity, widened from its 30m/2h
 * thresholds: this page ranks a multi-day queue, not a same-shift one, so a
 * 26-hour deadline has to read as different from a 2-day one.
 *
 * The 48h boundary is calm, not warn, deliberately — it is the moment the row
 * flips from "days" to a plain 2, and the least urgent row on the page should
 * not be wearing the same amber as one due this evening. */
export function severityFor(msLeft: number): OperatorSeverity {
  if (msLeft <= 2 * HOUR) return "crit";
  if (msLeft < 48 * HOUR) return "warn";
  return "calm";
}

/** `delivery_at` → the countdown the row renders. `null`/unparsable delivery
 * dates return a dashed, calm countdown rather than NaN — the same
 * null-guarding rule the scoring math follows (see CLAUDE.md). */
export function countdown(deliveryAt: string | null | undefined, now: number = Date.now()): Countdown {
  if (!deliveryAt) return { value: "—", unit: "no date set", severity: "calm", overdue: false };
  const at = new Date(deliveryAt).getTime();
  if (Number.isNaN(at)) return { value: "—", unit: "no date set", severity: "calm", overdue: false };

  const left = at - now;
  if (left <= 0) {
    // Past its deadline. "late" rather than "overdue": shorter, plainer, and
    // it fits the badge these rows render as instead of a countdown — a big
    // "9" over the words DAYS OVERDUE reads at a glance like nine days REMAIN,
    // which is the opposite of what it means. See OperatorClient's op-late.
    const lateBy = -left;
    if (lateBy < HOUR) {
      const mins = Math.max(1, Math.floor(lateBy / MINUTE));
      return { value: String(mins), unit: mins === 1 ? "min late" : "min late", severity: "crit", overdue: true };
    }
    const hrs = Math.floor(lateBy / HOUR);
    if (hrs < 48) return { value: String(hrs), unit: hrs === 1 ? "hour late" : "hours late", severity: "crit", overdue: true };
    const days = Math.floor(hrs / 24);
    return { value: String(days), unit: days === 1 ? "day late" : "days late", severity: "crit", overdue: true };
  }

  const severity = severityFor(left);
  const mins = Math.floor(left / MINUTE);
  if (mins < 60) return { value: String(mins), unit: mins === 1 ? "min left" : "min left", severity, overdue: false };
  const hrs = Math.floor(left / HOUR);
  if (hrs < 48) return { value: String(hrs), unit: hrs === 1 ? "hour left" : "hours left", severity, overdue: false };
  const days = Math.floor(hrs / 24);
  return { value: String(days), unit: days === 1 ? "day left" : "days left", severity, overdue: false };
}

/** Where the button goes. The order page is where nearly every control already
 * lives, and the anchor lands the operator on the right card once there. The
 * one exception is `route: "call"`, which has its own screen. */
export function operatorHref(orderId: string, action: OperatorAction): string {
  if (action.route) return `/orders/${orderId}/${action.route}`;
  return `/orders/${orderId}${action.anchor ?? ""}`;
}

// ── The order of the list ──────────────────────────────────────────────────
//
// gatherAttention ranks by its own `urgency` score, which is the right ranking
// for the Control panel — it weighs the KIND of problem (a breached offer SLA
// scores 100, an unplaceable order 90) and only then the clock.
//
// This page cannot use that order as-is, and the reason is not a disagreement
// about priority. It is that the operator can SEE the countdown and cannot see
// the score. Against the real staging queue, urgency order rendered as:
//
//     27 min left · 9 days overdue · 9 days overdue · 1 hour left · 25 hours left
//
// Every one of those positions is defensible, and the list still looks broken —
// which fails the only test this page has to pass ("knows, without being told,
// which order to handle first"). A ranking nobody can verify by eye is not a
// ranking to a new hire; it is noise.
//
// So the page sorts by the number it shows: furthest past its deadline first,
// then soonest due. `urgency` is kept as the tie-breaker, so within one moment
// in time cxAttention still decides — an offer nobody answered outranks a
// question a florist asked, both due at 18:00. Nothing about cxAttention
// changes; this is a view-level sort over its output.

interface SortableRow {
  deliveryAt: string | null;
  urgency: number;
}

/** Deadline order: overdue first (most overdue at the top), then soonest due,
 * then anything with no date at all. `urgency` breaks ties. */
export function byDeadline<T extends SortableRow>(rows: T[], now: number = Date.now()): T[] {
  const key = (r: T): number => {
    if (!r.deliveryAt) return Number.POSITIVE_INFINITY; // no date — last
    const at = new Date(r.deliveryAt).getTime();
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at - now;
  };
  // Sort a copy: the caller's array (gatherAttention's own result, which is
  // request-cached and shared with the sidebar badge) must not be reordered
  // underneath it.
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka - kb;
    return b.urgency - a.urgency;
  });
}
