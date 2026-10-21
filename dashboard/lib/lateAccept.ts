// Whether a florist may accept an offer — including one whose response window
// already lapsed. Pure, no I/O, unit-tested directly (lateAccept.test.mjs).
//
// This is the SAME shape as lib/reachout.ts::resendBlockReason, for the same
// reason: two callers have to agree. The florist PWA decides whether to render
// the Accept button (components/florist/FloristOrderDetail.tsx) and the API
// decides whether to honour the tap (app/api/florist/respond/route.ts). One
// predicate means the 409 a florist gets can never contradict the button they
// were shown.
//
// Background: `offer_expires_at` lapsing does NOT close an offer. The wave
// engine flips a lapsed offer to `expired` so it can promote the next candidate
// (lib/waves.ts), but the order itself may still be unclaimed — and a florist
// answering late is exactly what an escalated order needs. So `expired` means
// "the window lapsed", not "closed", and this predicate — not the status — is
// the authority. That mirrors `declined`, which has always been re-acceptable
// while the order is open.
//
// NO DELIVERY-TIME CUTOFF. There used to be one: an accept was refused inside
// `app_settings.late_accept_buffer_hours` of `delivery_at`, on the reasoning
// that there is no time left to make the delivery. In practice it produced the
// worst outcome available — order #2000019 sat unfulfilled at `reaching_out`
// with six offers out and 38 minutes to spare, and NOBODY could take it,
// because the buffer had lapsed an hour earlier. A florist close enough to
// deliver in 38 minutes was told no on our behalf.
//
// The rule now is simply: a florist may accept while the order is still open
// and nobody else has taken it. Whether there is time is the florist's call —
// they know their van and their stock — and the order-level CAS below is what
// stops two of them taking it.
//
// NOT the race lock. The order-level CAS in the respond route is still the sole
// authority on who wins when two florists accept at once; this runs first only
// so the loser gets an honest message instead of a generic refusal.

/** Why an accept is refused. `null` from acceptBlockReason means "allowed". */
export type AcceptBlockReason =
  | "order-deleted"     // the order was soft-deleted out from under the offer
  | "withdrawn"         // staff pulled this specific offer off the table
  | "assignment-closed" // terminal for THIS florist (accepted/reassigned/released/delivered)
  | "order-closed";     // another florist holds it, or the order is no longer open

/** Assignment states an accept can still come from. `expired` and `declined`
 *  are both in here deliberately: a lapsed window and a change of mind are
 *  recoverable, everything else is terminal for this florist. */
export const ACCEPTABLE_ASSIGNMENT_STATUSES = [
  "candidate", "queued", "sent", "opened", "declined", "expired",
] as const;

/** Order states that still want a florist. `received` is deliberately absent:
 *  in semi mode an order rests there with candidates written while CX reviews
 *  the match approval, and a candidate must not self-accept past that gate.
 *  `escalated` is deliberately present — an order in the CX queue because
 *  nobody took it is the one that most wants a late yes. */
export const ACCEPTABLE_ORDER_STATUSES = ["matched", "reaching_out", "escalated"] as const;

export interface AcceptAssignment {
  status: string;
  withdrawn_at: string | null;
}

export interface AcceptOrder {
  status: string;
  deleted_at: string | null;
}

/**
 * @returns the first rule that refuses, or null when the accept is allowed.
 */
export function acceptBlockReason(
  assignment: AcceptAssignment,
  order: AcceptOrder
): AcceptBlockReason | null {
  if (order.deleted_at) return "order-deleted";
  if (assignment.withdrawn_at) return "withdrawn";
  if (!(ACCEPTABLE_ASSIGNMENT_STATUSES as readonly string[]).includes(assignment.status)) {
    return "assignment-closed";
  }
  if (!(ACCEPTABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
    return "order-closed";
  }
  return null;
}

/** Staff-facing one-liner for each refusal — used for the API's 409 body and
 *  the florist's on-screen explanation, so both read the same. */
export const ACCEPT_BLOCK_MESSAGE: Record<AcceptBlockReason, string> = {
  "order-deleted": "This order was deleted.",
  withdrawn: "This offer was withdrawn.",
  "assignment-closed": "This offer is closed.",
  "order-closed": "This order was already taken.",
};
