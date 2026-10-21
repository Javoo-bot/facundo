// The two rules the reconcile sweeps turn on, kept pure and alias-free so
// plain `node --test` can reach them — the same constraint schedule.ts,
// recruitingContent.ts and offerSmsContent.ts carry. lib/sequences/reconcile.ts
// is the thin I/O around these.

/** Assignment statuses that mean an offer is still out with that florist.
 *
 * `accepted` is deliberately in the list: they are fulfilling an order right
 * now, and "join our network" landing mid-delivery reads as nobody in this
 * company talking to anybody else. */
export const LIVE_OFFER_STATUSES = ["sent", "opened", "accepted"] as const;

/** Should this florist's paused recruiting run come back?
 *
 * A paused run resumes exactly when the florist has no live offer left. This
 * is what stops `pauseRecruitingFor` being a one-way door — see reconcile.ts. */
export function shouldResumeRecruiting(liveOfferStatuses: string[]): boolean {
  return !liveOfferStatuses.some((s) => (LIVE_OFFER_STATUSES as readonly string[]).includes(s));
}

export interface ColdFollowUpFlorist {
  joined_at?: string | null;
  excluded_at?: string | null;
  deleted_at?: string | null;
}

/** Is this shop still worth the cold-offer follow-up? */
export function coldFollowUpEligible(florist: ColdFollowUpFlorist | null | undefined): boolean {
  if (!florist) return false;
  if (florist.joined_at) return false; // they took it — they're in the network
  if (florist.excluded_at || florist.deleted_at) return false;
  return true;
}
