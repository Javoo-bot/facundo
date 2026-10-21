// Offering a REAL order to a shop that has never joined the network.
//
// Pure, alias-free, unit-tested: every decision that governs whether we put a
// company card in front of an unvetted shop is a function you can read in one
// screen and assert on, rather than a condition buried in a route.
//
// The load-bearing idea: the activation gate is NOT bypassed, its INPUTS are
// supplied. `lib/floristActivation.ts::computeActivation` and the matcher's
// `passesHardFilter` both demand a linked login, a delivery radius and a trust
// tier. A cold accept mints the radius and the tier (and the magic-link redeem
// already creates the login), so afterwards the shop passes the same filter
// every other florist passes. No new path can offer to a shop that fails it.

/** The provisional trust tier: 70/30 — the split the recruiting copy promises —
 * with a photo gate and a small exposure cap. See the migration for why not
 * tier 2 (cap is 4x larger) and why not tier 3 (0/100 would make the copy a lie). */
export const PROVISIONAL_TIER = "5";

export interface ColdOfferSettings {
  cold_offer_enabled?: boolean | null;
  cold_offer_max_payout_eur?: number | string | null;
  cold_offer_auto_payout_cap_eur?: number | string | null;
  cold_offer_default_radius_km?: number | string | null;
}

export interface ColdCandidate {
  id: string;
  email: string | null;
  joined_at: string | null;
  excluded_at?: string | null;
  deleted_at?: string | null;
  lifecycle_stage?: string | null;
  order_emails_opt_out?: boolean | null;
  lat?: number | null;
  lng?: number | null;
}

export interface ColdOrder {
  /** What this florist would be paid, in euros. */
  payoutEur: number | null;
  /** When delivery is due. A shop with no login history should not be trusted
   * with a two-hour deadline. */
  deliveryAt: string | null;
}

function num(v: number | string | null | undefined, dflt: number): number {
  if (v === null || v === undefined) return dflt;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Hours before delivery under which a cold offer is refused. A florist we have
 * never spoken to has to read an unexpected email, decide, sign in for the
 * first time, and buy flowers — a rush order asks all of that of a stranger. */
export const COLD_OFFER_MIN_LEAD_HOURS = 6;

export type ColdBlockReason =
  | "disabled"
  | "already-joined"
  | "excluded"
  | "no-email"
  | "bad-email"
  | "opted-out"
  | "lost"
  | "no-location"
  | "payout-unknown"
  | "payout-too-high"
  | "too-urgent";

/**
 * An address that will actually survive being sent to.
 *
 * The same shape lib/acceptComms.ts, lib/clientComms.ts and lib/offerVars.ts
 * check before a send, duplicated here rather than imported because this module
 * is deliberately import-free: it is loaded by the ingest worker and by plain
 * `node --test`, neither of which can resolve the `@/` alias.
 *
 * Checking it HERE is the point. `!florist.email` alone let a malformed address
 * through the gate — the shop looked eligible, the wave sent to it, the send
 * refused with `florist-no-email`, and the candidate was closed as unreachable.
 * The shop was silently spent on a typo, and nothing said so.
 */
const SENDABLE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Why we may NOT cold-offer this order to this shop, or null when we may.
 *
 * Returns the reason rather than a boolean so every refusal can be logged and
 * explained on the order page — "no candidate" with no reason is the kind of
 * silence that costs a day of debugging. */
export function coldOfferBlockReason(
  florist: ColdCandidate,
  order: ColdOrder,
  settings: ColdOfferSettings | null | undefined,
  nowMs: number
): ColdBlockReason | null {
  // Fail closed: an unreadable settings row must never enable this.
  if (!settings?.cold_offer_enabled) return "disabled";
  if (florist.joined_at) return "already-joined"; // not cold — use the normal offer
  if (florist.excluded_at || florist.deleted_at) return "excluded";
  if (florist.lifecycle_stage === "lost" || florist.lifecycle_stage === "off-funnel") return "lost";
  if (!florist.email) return "no-email";
  if (!SENDABLE_EMAIL.test(florist.email.trim())) return "bad-email";
  if (florist.order_emails_opt_out) return "opted-out";
  // The matcher needs coordinates to have ranked them at all; without them we
  // cannot claim they are near the delivery address.
  if (florist.lat == null || florist.lng == null) return "no-location";

  if (order.payoutEur == null) return "payout-unknown";
  if (order.payoutEur > num(settings.cold_offer_max_payout_eur, 120)) return "payout-too-high";

  if (order.deliveryAt) {
    const leadHours = (Date.parse(order.deliveryAt) - nowMs) / (60 * 60 * 1000);
    if (Number.isFinite(leadHours) && leadHours < COLD_OFFER_MIN_LEAD_HOURS) return "too-urgent";
  }

  return null;
}

export function coldOfferEligible(
  florist: ColdCandidate,
  order: ColdOrder,
  settings: ColdOfferSettings | null | undefined,
  nowMs: number
): boolean {
  return coldOfferBlockReason(florist, order, settings, nowMs) === null;
}

/** `order_assignments.offer_audience`. `cold` is stamped by the wave engine
 * just before it auto-offers a shop outside the network; `manual` by staff
 * attaching such a shop by hand (POST /api/orders/assign). Only `cold` feeds
 * the lapsed-offer follow-up funnel (lib/sequences/reconcile.ts): a manual
 * candidate may never have been sent anything. */
export type OfferAudience = "network" | "cold" | "manual";

export type ProvisionalSource = "cold_offer" | "manual_assign";

/** Which accepts mint a provisional activation, and what they record as its
 * source. Both mint through the same function with the same tier. */
const PROVISIONAL_SOURCE_ON_ACCEPT: Record<OfferAudience, ProvisionalSource | null> = {
  network: null,
  cold: "cold_offer",
  manual: "manual_assign",
};

export function provisionalSourceOnAccept(audience: string | null | undefined): ProvisionalSource | null {
  return PROVISIONAL_SOURCE_ON_ACCEPT[audience as OfferAudience] ?? null;
}

/** The audience a staff manual assign stamps. `manual` exactly when the wave
 * engine would have had to cold-offer this shop: not joined and not onboarded.
 * Anyone else is a normal network offer and is left alone. */
export function manualAssignAudience(florist: {
  joined_at: string | null;
  lifecycle_stage: string | null;
}): OfferAudience {
  if (florist.joined_at) return "network";
  if (florist.lifecycle_stage === "production" || florist.lifecycle_stage === "onboarding") return "network";
  return "manual";
}

export interface ProvisionalActivation {
  trust_tier: string;
  delivery_radius_km: number;
  joined_at: string;
  lifecycle_stage: string;
  provisional_activated_at: string;
  provisional_source: ProvisionalSource;
}

/** The florist-row patch a cold (or manual-assign) accept writes.
 *
 * `lifecycle_stage` goes to `onboarding`, never `production`: nobody has vetted
 * this shop, and `production` is the stage that says somebody has. Existing
 * values further along are preserved by the caller's CAS — this only ever
 * promotes a prospect.
 *
 * Existing non-null radius/tier must be PRESERVED by the caller (the update is
 * conditional per field); this function describes the defaults for a shop that
 * has neither, which is the only case that reaches it. */
export function buildProvisionalActivation(
  settings: ColdOfferSettings | null | undefined,
  nowIso: string,
  source: ProvisionalSource = "cold_offer"
): ProvisionalActivation {
  return {
    trust_tier: PROVISIONAL_TIER,
    delivery_radius_km: num(settings?.cold_offer_default_radius_km, 12),
    joined_at: nowIso,
    lifecycle_stage: "onboarding",
    provisional_activated_at: nowIso,
    provisional_source: source,
  };
}

/** Should this provisional shop's 70% accept leg be HELD for CX release rather
 * than issued unattended?
 *
 * Only for provisional shops, and only above the auto cap — below it the money
 * moves instantly, which is what the recruiting copy promised and what makes
 * the offer worth accepting. */
export function shouldHoldAcceptLeg(
  tierCode: string | null | undefined,
  amountEur: number | null | undefined,
  settings: ColdOfferSettings | null | undefined
): boolean {
  if (tierCode !== PROVISIONAL_TIER) return false;
  if (amountEur == null || !Number.isFinite(amountEur)) return true; // unknown amount → hold
  return amountEur > num(settings?.cold_offer_auto_payout_cap_eur, 90);
}
