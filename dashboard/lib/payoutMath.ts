export interface TierSplit { split_on_accept: number; split_on_delivery: number; photo_required: boolean; hold_payout: boolean; }
export interface PayoutRail {
  issue(amountCents: number, currency: string, ref: string):
    Promise<{ ok: true; providerRef: string; last4?: string; expiry?: string } | { ok: false; error: string }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Floor a cent-scale quantity, dropping the fraction rather than rounding it up
// — used by the leg split below, where a hand-set payout can carry sub-cent
// parts the whole-unit floor never sees.
//
// The epsilon absorbs IEEE-754 dust ONLY, and it is load-bearing: scaling euros
// to cents lands a hair UNDER the true integer surprisingly often (0.29 * 100 is
// 28.999999999999996 — one in ~17 values under €200 does this), and a bare
// Math.floor would eat a whole real cent there. 1e-6 of a cent is far too small
// to promote a genuine fraction.
const floorCents = (cents: number) => Math.floor(cents + 1e-6);

// Floor a payout to a WHOLE unit of currency — €53.63 pays €53.00. The
// fractional part is dropped entirely rather than rounded, so it stays with
// Facundo. Exported for the clawback path, which recomputes a florist total
// off an edited order and must round the same direction as the original payout
// (see lib/payout.ts).
//
// The epsilon is defensive: a sweep of the real input space turns up no case
// where a true whole number arrives a hair under it, but the cost of being
// wrong is now a whole euro rather than a cent, so it's cheap insurance. It
// cannot round anything real up — every legitimate value on this path is a
// multiple of 1/10000 (an integer cent basis × an integer percent), four orders
// of magnitude above 1e-6.
export function floorPayout(amount: number): number {
  return Math.floor(amount + 1e-6);
}

// The florist's payout base — the order's actual total (what we collected:
// items net of any discount code, plus shipping; tax-inclusive pricing means
// there's no separate tax to add). Basis used to be items + delivery at their
// PRE-discount price specifically so a discount code wouldn't shrink the
// florist's cut — but that meant a heavily-discounted order (a customer
// coupon) could pay out most or nearly all of what we actually collected,
// since the basis didn't reflect the discount at all. `percent` is 0-100
// (app_settings.default_payout_percent).
//
// Rounds the basis to whole cents before multiplying by percent — money values
// arrive as doubles, and summing them raw drifts below the true value (49.80 +
// 25.90 is 75.69999999999999). Keeping the basis in exact integer cents means
// `basisCents * percent` is an exact integer for the integer percents we use,
// so the only inexact step is the final divide.
//
// The result then floors to a WHOLE unit of currency, not to cents:
// €75.70 × 55% = €41.635 pays €41.00. Everything below the euro stays
// with Facundo.
export function computePayoutPrice(orderTotal: number, percent: number): number {
  const basisCents = Math.round(orderTotal * 100);
  return floorPayout((basisCents * percent) / 10_000); // cents × percent → whole units
}

// Split an already-floored payout into its two legs. A whole-unit total against
// an integer tier split usually divides exactly (70/30 of €41 is €28.70 +
// €12.30), so the cent handling below is a safety net rather than the common
// path — it earns its keep on a payout_price a human set by hand
// (/api/orders/payout/override), which need not be whole or even round.
//
// There the accept leg floors and the delivery leg takes the REMAINDER rather
// than flooring independently, so the legs always sum to exactly the total the
// florist was quoted instead of landing a cent short of it. Tiers are validated
// to sum to 100% (POST /api/trust-tiers) — a legacy row that doesn't falls back
// to flooring each leg on its own.
export function computeSplit(total: number | null, tier: TierSplit) {
  const acceptPct = tier.split_on_accept ?? 0;
  const deliveryPct = tier.split_on_delivery ?? 0;
  const totalCents = floorCents((total ?? 0) * 100);
  const acceptCents = floorCents((totalCents * acceptPct) / 100);
  const deliveryCents = acceptPct + deliveryPct === 100
    ? totalCents - acceptCents
    : floorCents((totalCents * deliveryPct) / 100);
  return {
    accept: acceptCents / 100,
    delivery: deliveryCents / 100,
    photoRequired: !!tier.photo_required,
    hold: !!tier.hold_payout,
    singlePayment: isSinglePayment(tier),
  };
}

// "This shop is paid in one go, on accept." True for any tier whose delivery
// leg is 0% — tier 1 ("Trusted") today, and anything else we
// add later on the same shape.
//
// This is THE predicate every florist-facing surface asks before choosing its
// wording, deliberately derived from the split itself rather than a tier code:
// copy that reads the data can never drift from the money, and a tier renamed
// or renumbered doesn't silently start lying about how a shop gets paid.
//
// Note it is about the SPLIT, not about the photo. A single-payment shop still
// owes us a delivery photo when `photo_required` says so; that photo is proof
// of delivery, and it gates nothing. The two facts are independent and the copy
// has to state both.
export function isSinglePayment(tier: Pick<TierSplit, "split_on_delivery">): boolean {
  return (tier.split_on_delivery ?? 0) === 0;
}

// paidSoFar = sum of already-issued legs. newPayout = the corrected total payout (null = full cancel).
export function clawbackAmount(paidSoFar: number, newPayout: number | null): number {
  if (newPayout == null) return round2(paidSoFar);
  return round2(Math.max(0, paidSoFar - newPayout));
}

// A florist WE own (florists.is_test_shop — real order-loop test shops, and the
// demo shops dashboard/lib/testing/demoSandbox.ts creates) must never receive a
// REAL Airwallex card on PRODUCTION, whatever app_settings.payments_live says
// globally. The global flag governs everyone else; for a test shop the only way
// `live` can come back true is the caller passing testShopLiveAllowed=true —
// railGate.ts::testShopLiveAllowed decides that, and it is false by default and
// false unconditionally for a /testing demo-sandbox order, so a caller that
// forgets the argument (or omits it) still fails toward the safe (ledger, no
// real money) rail.
export function effectivePaymentsLive(live: boolean, isTestShop: boolean, testShopLiveAllowed = false): boolean {
  return isTestShop ? live && testShopLiveAllowed : live;
}

// --- Total payout for one order/assignment (accept leg + delivery leg) -------
//
// Used to write "Tookan Cost Of Order" back to Shopify at delivery (both legs
// exist by then — see lib/shopifyWriteback.ts). Lives here (not lib/payout.ts,
// where it's called from) so it unit-tests under plain `node --test`:
// lib/payout.ts imports lib/supabaseAdmin.ts via an extensionless specifier,
// which plain `node --test`'s native TS type-stripping can't resolve (no
// alias/extension guessing, unlike webpack/Next). This module has no such
// import, so it stays trivially importable — same reason unionTags lives in
// lib/shopifyTags.ts instead of lib/shopifyWriteback.ts.

export interface PayoutLegRow {
  leg: "accept" | "delivery" | "manual";
  amount: number | null;
  status: string;
}

// Which statuses count toward "Cost Of Order": 'issued' (the rail actually
// moved money — see lib/payout.ts::issueAndFinalize, which sets 'issued' on
// success) AND 'clawed_back'. Deliberately excluded, and why each is not
// "cost we've incurred" (net) yet:
//   'held'         reserved but not released — CX hasn't approved it (see
//                  lib/payoutHold.ts). Counting it would report a florist paid
//                  before they were; the field is literally "Cost Of Order",
//                  not "amount we intend to pay eventually".
//   'pending'      the brief in-flight window between insert and finalize.
//                  By the time this is read (after payoutOnDelivered has
//                  resolved) both legs should already have settled to
//                  issued/failed/held — a row still 'pending' here is a
//                  DB-consistency-window edge case, not the common path — but
//                  it is excluded rather than guessed at.
//   'failed'       the rail attempt errored — no money moved.
// 'clawed_back' IS included, not excluded: clawback_order() (see
// supabase/migrations/2026-07-14-payments-atomicity.sql) reclaims by INSERTING
// a new row with a NEGATIVE amount and status='clawed_back' — it never touches
// the original 'issued' row's status. So the original 'issued' row and its
// offsetting 'clawed_back' row are two separate rows that must BOTH be summed
// to get the net currently paid; excluding 'clawed_back' (the earlier version
// of this function did) silently drops the reclaim and reports the stale gross
// instead — confirmed as a live bug against real order #2000013 (an accept leg
// issued then fully clawed back nets to 0, but the old filter reported the
// original issued amount as still owed).
// A null `amount` (shouldn't happen for a real row, but guarded per CLAUDE.md's
// null-safety convention) contributes 0, never NaN.
// Sums in integer cents (epsilon-guarded, same idiom as floorCents above) and
// divides back down, rather than a bare float reduce — two already
// cent-scale legs (29.14 + 12.49) can still land a hair off a true cent in
// IEEE-754, and a caller that trusts the raw sum rather than immediately
// formatting it would see that drift.
export function sumPayoutLegs(rows: PayoutLegRow[]): number {
  const cents = rows
    .filter((r) => r.status === "issued" || r.status === "clawed_back")
    .reduce((sum, r) => sum + Math.round((r.amount ?? 0) * 100 + 1e-6), 0);
  return cents / 100;
}
