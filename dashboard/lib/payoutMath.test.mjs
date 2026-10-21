import test from "node:test";
import assert from "node:assert/strict";
import { computeSplit, clawbackAmount, computePayoutPrice, floorPayout, effectivePaymentsLive, isSinglePayment, sumPayoutLegs } from "./payoutMath.ts";

const Z = { split_on_accept: 70, split_on_delivery: 30, photo_required: false, hold_payout: false };
const Y = { split_on_accept: 70, split_on_delivery: 30, photo_required: true, hold_payout: false };
const X = { split_on_accept: 0, split_on_delivery: 100, photo_required: true, hold_payout: false };
// A single-payment tier (tier 1 on staging today): the whole payout on
// accept, and the delivery photo still required —
// as proof of delivery, not as the thing releasing the second leg.
const FULL = { split_on_accept: 100, split_on_delivery: 0, photo_required: true, hold_payout: false };

test("computePayoutPrice is the order's actual total (what we collected) times the percent", () => {
  assert.equal(computePayoutPrice(100, 55), 55);
  assert.equal(computePayoutPrice(0, 55), 0);
  assert.equal(computePayoutPrice(25, 40), 10); // already whole → untouched by the floor
});

test("computePayoutPrice floors to a WHOLE unit — the remainder stays with Facundo", () => {
  assert.equal(computePayoutPrice(97.51, 55), 53); // €53.6305 → €53.00
  // Real order #2000001: €75.70 total × 55% = €41.635 → €41.00.
  assert.equal(computePayoutPrice(75.7, 55), 41);
  assert.equal(computePayoutPrice(10, 55), 5); // €5.50 → €5.00, not €6
  assert.equal(computePayoutPrice(29.99, 70), 20); // €20.993 → €20.00
  // A payout that lands just under a whole unit floors to the one below — the
  // fraction is dropped, never nudged up.
  assert.equal(computePayoutPrice(99.99, 100), 99);
});

// Real order #6a652a04 (2026-08-23): a 25%-off discount code (FCLASTCHANCE25)
// dropped the collected total to €78.75 against €101.70 of pre-discount items
// + shipping. The basis must track what we actually collected, not the
// pre-discount price — the discount is Facundo's to absorb or not, not a
// reason to inflate the florist's cut past what came in.
test("computePayoutPrice tracks the discounted total actually collected, not the pre-discount price", () => {
  assert.equal(computePayoutPrice(78.75, 55), 43); // €43.3125 → €43.00, not €55.94/€55.00
});

test("computePayoutPrice keeps a genuinely whole payout whole (no float shaves a euro off)", () => {
  assert.equal(computePayoutPrice(100, 54), 54);
  assert.equal(computePayoutPrice(75.7, 100), 75);
  // Sweep the real input space: a payout whose exact value IS a whole number
  // must never come back one euro light through floating-point drift.
  for (let cents = 1; cents <= 50_000; cents++) {
    for (const pct of [40, 50, 55, 62, 70, 100]) {
      const exact = (cents * pct) / 10_000;
      if (Number.isInteger(Math.round(exact)) && Math.abs(exact - Math.round(exact)) < 1e-9) {
        assert.equal(computePayoutPrice(cents / 100, pct), Math.round(exact));
      }
    }
  }
});

test("computeSplit divides a whole-unit payout exactly and honours the tier", () => {
  assert.deepEqual(computeSplit(41, Z), { accept: 28.7, delivery: 12.3, photoRequired: false, hold: false, singlePayment: false });
  assert.deepEqual(computeSplit(53, Y), { accept: 37.1, delivery: 15.9, photoRequired: true, hold: false, singlePayment: false });
});

test("computeSplit still floors to cents on a hand-set (non-whole) payout", () => {
  assert.deepEqual(computeSplit(114, Z), { accept: 79.8, delivery: 34.2, photoRequired: false, hold: false, singlePayment: false });
  assert.deepEqual(computeSplit(99.9, X), { accept: 0, delivery: 99.9, photoRequired: true, hold: false, singlePayment: false });
  assert.deepEqual(computeSplit(null, Z), { accept: 0, delivery: 0, photoRequired: false, hold: false, singlePayment: false });
});

test("computeSplit legs always sum to the quoted total (delivery takes the remainder)", () => {
  // Only reachable via a staff payout override, which need not be whole:
  // 41.63 × 70% = 29.141 → the accept leg floors to 29.14 and the delivery leg
  // is what's left (12.49), never 29.14 + 12.48 against a 41.63 total.
  const z = computeSplit(41.63, Z);
  assert.deepEqual([z.accept, z.delivery], [29.14, 12.49]);
  assert.equal(Math.round((z.accept + z.delivery) * 100) / 100, 41.63);
  const y = computeSplit(41.63, Y);
  assert.deepEqual([y.accept, y.delivery], [29.14, 12.49]);
  assert.equal(Math.round((y.accept + y.delivery) * 100) / 100, 41.63);
});

test("floorPayout drops everything below the whole unit", () => {
  assert.equal(floorPayout(53.63), 53);
  assert.equal(floorPayout(53.99), 53);
  assert.equal(floorPayout(53), 53);
  assert.equal(floorPayout(0.99), 0);
  assert.equal(floorPayout(0), 0);
  assert.equal(floorPayout((75.7 * 55) / 100), 41); // the clawback path's own expression
});

test("clawback: full cancel reclaims all paid legs; edit-lower reclaims the delta", () => {
  assert.equal(clawbackAmount(80, null), 80);      // full cancel: reclaim everything paid
  assert.equal(clawbackAmount(80, 100 /* new payout */), 0);   // new >= paid: nothing to claw
  assert.equal(clawbackAmount(80, 60), 20);        // edit-lower: reclaim the 20 overpaid
});

// A demo/test shop (florists.is_test_shop) must never receive a real Airwallex
// card, whatever app_settings.payments_live says globally — see lib/payout.ts.
test("effectivePaymentsLive can only ever turn live OFF, never on", () => {
  assert.equal(effectivePaymentsLive(true, false), true);   // real florist, live payments on -> real card
  assert.equal(effectivePaymentsLive(true, true), false);   // test shop, live payments on -> forced ledger
  assert.equal(effectivePaymentsLive(false, false), false); // ledger regardless
  assert.equal(effectivePaymentsLive(false, true), false);  // ledger regardless
});

test("the omitted third argument defaults to the SAFE reading", () => {
  // Every pre-existing call site passes two arguments. If the default were
  // `true` the whole test-shop protection would evaporate silently on upgrade,
  // so this pins it: no third argument == no sandbox == forced ledger.
  assert.equal(effectivePaymentsLive(true, true), effectivePaymentsLive(true, true, false));
});

// The one narrow, explicit exception: railGate.ts::testShopLiveAllowed decides
// whether a test shop may rehearse a real SANDBOX card (demo host +
// AIRWALLEX_ALLOW_DEMO_LIVE=1, and never for a /testing demo order) —
// effectivePaymentsLive just has to honour that decision. A fake PAN with no
// money behind it is not "a real card", so the invariant above is intact.
test("effectivePaymentsLive: a test shop can go live only when testShopLiveAllowed says so", () => {
  assert.equal(effectivePaymentsLive(true, true, true), true);    // sandbox opt-in -> real (sandbox) card
  assert.equal(effectivePaymentsLive(true, false, true), true);   // real florist unaffected / arg irrelevant
  assert.equal(effectivePaymentsLive(true, true, false), false);  // no opt-in -> unchanged, forced ledger
  assert.equal(effectivePaymentsLive(false, true, true), false);  // payments off still wins over everything
  assert.equal(effectivePaymentsLive(false, false, true), false);
});

test("testShopLiveAllowed NEVER overrides the global kill switch", () => {
  // payments_live=false is the operator's switch; nothing below it may turn the
  // card rail back on, sandbox included.
  for (const isTest of [true, false]) {
    for (const sandbox of [true, false]) {
      assert.equal(effectivePaymentsLive(false, isTest, sandbox), false);
    }
  }
});

// --- sumPayoutLegs: "Tookan Cost Of Order" = sum of ISSUED + CLAWED_BACK legs
//
// Written back to Shopify at delivery — see lib/shopifyWriteback.ts. The rule
// (lib/payoutMath.ts's own header comment): 'issued' and 'clawed_back' both
// count (a clawback nets against the issued row it reclaimed). Every
// other status is excluded because no money has (net) moved yet, or moved and
// was reclaimed.

test("both legs issued sums them", () => {
  assert.equal(sumPayoutLegs([
    { leg: "accept", amount: 28.7, status: "issued" },
    { leg: "delivery", amount: 12.3, status: "issued" },
  ]), 41);
});

test("a held delivery leg (the real case: parked for CX approval after a review/fail photo verdict) contributes nothing — only the issued accept leg counts", () => {
  assert.equal(sumPayoutLegs([
    { leg: "accept", amount: 28.7, status: "issued" },
    { leg: "delivery", amount: 12.3, status: "held" },
  ]), 28.7);
});

test("pending and failed legs are excluded — no money moved", () => {
  for (const status of ["pending", "failed"]) {
    assert.equal(
      sumPayoutLegs([
        { leg: "accept", amount: 28.7, status: "issued" },
        { leg: "delivery", amount: 12.3, status },
      ]),
      28.7,
      `status ${status} must not count toward Cost Of Order`,
    );
  }
});

// clawed_back IS included (not excluded) — clawback_order() reclaims by
// inserting a NEW negative-amount row with this status, leaving the original
// 'issued' row untouched (see supabase/migrations/2026-07-14-payments-atomicity.sql).
// Real order #2000013: an accept leg issued at 24.5, then fully clawed back
// (-24.5) — net paid is 0, not 24.5.
test("clawed_back legs net against the issued row they reclaimed — real order #2000013", () => {
  assert.equal(sumPayoutLegs([
    { leg: "accept", amount: 24.5, status: "issued" },
    { leg: "accept", amount: -24.5, status: "clawed_back" },
  ]), 0);
});

test("a partial clawback nets to the remaining paid amount", () => {
  assert.equal(sumPayoutLegs([
    { leg: "accept", amount: 28.7, status: "issued" },
    { leg: "delivery", amount: 12.3, status: "issued" },
    { leg: "accept", amount: -10, status: "clawed_back" },
  ]), 31);
});

test("a null or undefined amount on an issued row contributes 0, never NaN", () => {
  assert.equal(sumPayoutLegs([{ leg: "accept", amount: null, status: "issued" }]), 0);
  assert.equal(sumPayoutLegs([{ leg: "accept", amount: undefined, status: "issued" }]), 0);
  const mixed = sumPayoutLegs([
    { leg: "accept", amount: null, status: "issued" },
    { leg: "delivery", amount: 12.3, status: "issued" },
  ]);
  assert.equal(mixed, 12.3);
  assert.equal(Number.isNaN(mixed), false);
});

test("an empty row list sums to 0", () => {
  assert.equal(sumPayoutLegs([]), 0);
});

test("floating-point: sumPayoutLegs rounds through integer cents, so IEEE-754 dust never survives the sum", () => {
  // 0.1 + 0.2 is the textbook case — a bare float reduce would return
  // 0.30000000000000004. sumPayoutLegs rounds each leg to integer cents
  // before summing (see lib/payoutMath.ts), so the raw return value is
  // already clean — callers don't need to format defensively to get 0.3.
  const clean = sumPayoutLegs([
    { leg: "accept", amount: 0.1, status: "issued" },
    { leg: "delivery", amount: 0.2, status: "issued" },
  ]);
  assert.equal(clean, 0.3);

  // Real accept/delivery splits (computeSplit's output, cent-floored) recombine
  // exactly too — e.g. the two legs of a €41.63 payout:
  assert.equal(sumPayoutLegs([
    { leg: "accept", amount: 29.14, status: "issued" },
    { leg: "delivery", amount: 12.49, status: "issued" },
  ]), 41.63);
});

// ---------------------------------------------------------------------------
// The generated worker copy.
// ---------------------------------------------------------------------------

test("ingest-worker/src/payoutMath.ts is byte-identical to this file's source", async () => {
  // The worker and dashboard are separate builds and can't import from each
  // other, so ingest-worker/src/db.ts::insertCandidates used to hand-duplicate
  // computePayoutPrice/floorPayout inline instead of importing them, "kept in
  // lockstep" by comment only. That's exactly how a real florist got overpaid
  // on order #2000029 (2026-08-17, €40 paid vs €29 owed): this file's basis
  // got fixed to track the order's actual (post-discount) total without the
  // worker's inlined copy getting the same fix, and nothing would have caught
  // it happening again either way.
  //
  // Byte equality replaces all of that: there is nothing left to approximate.
  // Same fix already applied to lib/match.ts — see sync-match.mjs.
  const { readFileSync } = await import("node:fs");
  const canonical = readFileSync(new URL("./payoutMath.ts", import.meta.url), "utf8");
  const generated = readFileSync(new URL("../../ingest-worker/src/payoutMath.ts", import.meta.url), "utf8");
  assert.equal(
    generated,
    canonical,
    "ingest-worker/src/payoutMath.ts is out of date — copy lib/payoutMath.ts over it byte-for-byte"
  );
});

// ---- paid in full on accept (a 0% delivery leg) -----------------------------

test("a 100/0 tier puts the whole payout on the accept leg and nothing on delivery", () => {
  assert.deepEqual(computeSplit(41, FULL), {
    accept: 41,
    delivery: 0,
    photoRequired: true, // still owed, as proof of delivery
    hold: false,
    singlePayment: true,
  });
  // A hand-set, non-whole override still lands entirely on the accept leg
  // rather than leaking a cent into a leg that will never be issued.
  const odd = computeSplit(41.63, FULL);
  assert.deepEqual([odd.accept, odd.delivery], [41.63, 0]);
});

test("isSinglePayment keys off the delivery leg alone, not a tier code", () => {
  assert.equal(isSinglePayment(FULL), true);
  assert.equal(isSinglePayment(Z), false);
  assert.equal(isSinglePayment(X), false); // 0% ACCEPT is not the same thing
  // A legacy row with a null delivery split reads as 0 — the honest reading of
  // "nothing is scheduled for the delivery leg".
  assert.equal(isSinglePayment({ split_on_delivery: null }), true);
});

test("photo_required is independent of the split — a paid-in-full shop still owes a photo", () => {
  // The whole point of this tier: the photo obligation survives the payment change.
  // If these ever coupled, the copy asserting "we still need a photo" would be
  // a promise the data no longer backs.
  assert.equal(computeSplit(50, FULL).photoRequired, true);
  assert.equal(computeSplit(50, { ...FULL, photo_required: false }).photoRequired, false);
  assert.equal(computeSplit(50, { ...FULL, photo_required: false }).singlePayment, true);
});
