// Who is worth reactivating, and which of the two conversations they need.
//
// The pure part is the CLASSIFICATION, which is the bit worth being careful
// about: sending a shop that has never delivered for us "it's been a while
// since your last order" is visibly wrong and tells them nobody here is paying
// attention. Getting that backwards is worse than staying quiet.

/** Days since joining before a florist who has never accepted is worth nudging.
 * Short enough to still be relevant, long enough that they have plausibly seen
 * at least one offer come through and chosen not to take it. */
export const NEVER_ACCEPTED_AFTER_DAYS = 14;

/** Days of silence before an active florist counts as dormant. Deliberately
 * generous: florists have seasons, and a shop that simply had a quiet month
 * does not want to be asked whether it still wants our business. */
export const DORMANT_AFTER_DAYS = 60;

export interface ReactivationCandidate {
  joined_at: string | null;
  excluded_at?: string | null;
  deleted_at?: string | null;
  order_emails_opt_out?: boolean | null;
  /** Most recent accepted/delivered assignment, if any. */
  lastAcceptedAt: string | null;
  /** Whether we have ever offered them anything. Someone who joined and has
   * simply never been offered an order has nothing to reactivate — the failure
   * is ours, and asking them why they haven't taken one would be absurd. */
  hasBeenOffered: boolean;
}

export type ReactivationKind = "reactivate_never_accepted" | "reactivate_dormant";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which reactivation sequence this florist needs, or null for none.
 *
 * Returns null generously. Every one of these is a message to somebody we
 * already have a working relationship with, and the cost of an unnecessary one
 * is higher than the cost of staying quiet. */
export function reactivationKind(c: ReactivationCandidate, nowMs: number): ReactivationKind | null {
  if (!c.joined_at) return null;              // not in the network
  if (c.excluded_at || c.deleted_at) return null;
  if (c.order_emails_opt_out) return null;

  const joinedMs = Date.parse(c.joined_at);
  if (!Number.isFinite(joinedMs)) return null;

  if (c.lastAcceptedAt) {
    const lastMs = Date.parse(c.lastAcceptedAt);
    if (!Number.isFinite(lastMs)) return null;
    // Clock skew or a future-dated row: no evidence of dormancy.
    if (lastMs > nowMs) return null;
    return nowMs - lastMs >= DORMANT_AFTER_DAYS * DAY_MS ? "reactivate_dormant" : null;
  }

  // Never accepted anything.
  if (!c.hasBeenOffered) return null;         // nothing to reactivate — that's on us
  if (joinedMs > nowMs) return null;
  return nowMs - joinedMs >= NEVER_ACCEPTED_AFTER_DAYS * DAY_MS ? "reactivate_never_accepted" : null;
}
