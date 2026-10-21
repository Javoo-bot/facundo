// Sanity assertions for the payout hold rule. Run with:
//   node --test lib/payoutHold.test.mjs
//
// This is the rule that decides whether a florist gets paid now or waits for a
// human, on a LIVE payments account. The tests below are written as the policy
// statements they enforce, so a future change that quietly re-introduces a
// workflow-mode gate fails with a readable name.
import test from "node:test";
import assert from "node:assert/strict";
import { payoutHoldReason, shouldSweepReleaseHeldPayout, resolvePaymentsPaused } from "./payoutHold.ts";

// --- the change: accepting and delivering are self-approving -----------------

test("accepting an order pays the 70% immediately", () => {
  assert.equal(payoutHoldReason({ leg: "accept" }), null);
});

test("a delivery photo releases the 30% immediately", () => {
  assert.equal(payoutHoldReason({ leg: "delivery" }), null);
});

test("workflow mode is not an input at all — semi cannot hold a leg", () => {
  // The regression this file exists for. `semi` used to hold BOTH legs, which
  // on the live account meant every payout queued behind CX. There is now no
  // way to express "hold because of the workflow mode": the field is gone.
  assert.equal(payoutHoldReason({ leg: "accept" }), null);
  assert.equal(payoutHoldReason({ leg: "delivery" }), null);
  // Passing the old field through as an unknown extra must not resurrect it.
  assert.equal(payoutHoldReason({ leg: "accept", mode: "semi" }), null);
  assert.equal(payoutHoldReason({ leg: "delivery", mode: "manual" }), null);
});

// --- what still holds: findings, not workflow steps --------------------------

test("an untrusted tier holds either leg", () => {
  assert.equal(payoutHoldReason({ leg: "accept", tierHold: true }), "tier-hold");
  assert.equal(payoutHoldReason({ leg: "delivery", tierHold: true }), "tier-hold");
});

test("a provisional cold-offer shop holds the accept leg only", () => {
  assert.equal(payoutHoldReason({ leg: "accept", provisionalHold: true }), "provisional-shop");
  // Having delivered and proved it, the same shop must not be blocked again.
  assert.equal(payoutHoldReason({ leg: "delivery", provisionalHold: true }), null);
});

// --- photo-verdict holding is disabled (2026-08-20) --------------------------
//
// The AI photo check still runs and still writes to `photo_verifications` —
// see lib/payoutHold.ts's header comment for why (5/5 recorded verdicts were
// `review`, including two photos of shoe boxes the agent still didn't fail
// hard) — but its verdict is no longer an input to this function at all, so
// there is no way to make it hold a leg.

test("a photo the AI check rejects or flags does not hold the 30% — the hold is disabled", () => {
  // payoutHoldReason() no longer even accepts a verdict; passing one through
  // as an unknown extra must not resurrect the old hold.
  assert.equal(payoutHoldReason({ leg: "delivery", verdict: "fail" }), null);
  assert.equal(payoutHoldReason({ leg: "delivery", verdict: "review" }), null);
  assert.equal(payoutHoldReason({ leg: "delivery", verdict: "pass" }), null);
});

// --- the operator overrides -------------------------------------------------

test("an operator can still switch the 30% back to manual release", () => {
  assert.equal(payoutHoldReason({ leg: "delivery", holdDelivery: true }), "delivery-gate");
  // ...and that switch is delivery-only; it must never strand the accept leg.
  assert.equal(payoutHoldReason({ leg: "accept", holdDelivery: true }), null);
});

test("the staff force-release overrides every gate", () => {
  assert.equal(
    payoutHoldReason({ leg: "delivery", force: true, tierHold: true, holdDelivery: true }),
    null,
  );
  assert.equal(payoutHoldReason({ leg: "accept", force: true, provisionalHold: true, tierHold: true }), null);
});

// --- reporting --------------------------------------------------------------

test("the strongest reason is reported when several apply", () => {
  // The reason lands in payment_events.payload.reason, so it should name the
  // thing about the florist, not the operator's switch.
  assert.equal(
    payoutHoldReason({ leg: "delivery", tierHold: true, holdDelivery: true }),
    "tier-hold",
  );
  assert.equal(payoutHoldReason({ leg: "delivery", holdDelivery: true }), "delivery-gate");
});

test("a manual payout has no leg-specific gate but still respects the tier", () => {
  assert.equal(payoutHoldReason({ leg: "manual" }), null);
  assert.equal(payoutHoldReason({ leg: "manual", tierHold: true }), "tier-hold");
  // Neither delivery gate applies to a leg that isn't the delivery leg.
  assert.equal(payoutHoldReason({ leg: "manual", holdDelivery: true }), null);
});

// --- the unattended release sweep --------------------------------------------
//
// Held payouts have no manual release surface in the UI today (see
// lib/payoutHold.ts), so a normal-safe hold that expires — the operator's
// delivery-gate switch was on and has since been turned back off — must not
// sit forever. shouldSweepReleaseHeldPayout is the pure decision the cron
// sweep (lib/payout.ts::sweepHeldPayouts) acts on.

test("a delivery-gate hold releases once the operator's switch is back off", () => {
  assert.equal(
    shouldSweepReleaseHeldPayout({ leg: "delivery", storedReason: "delivery-gate", paused: false, holdDelivery: false }),
    true,
  );
});

test("the payments kill switch always wins — never sweeps while paused", () => {
  assert.equal(
    shouldSweepReleaseHeldPayout({ leg: "delivery", storedReason: "delivery-gate", paused: true, holdDelivery: false }),
    false,
  );
});

test("a delivery-gate hold stays held while the switch is still on", () => {
  assert.equal(
    shouldSweepReleaseHeldPayout({ leg: "delivery", storedReason: "delivery-gate", paused: false, holdDelivery: true }),
    false,
  );
});

test("substantive findings are never swept, regardless of settings", () => {
  // "photo-verdict" can no longer be freshly PARKED (that hold is disabled,
  // 2026-08-20 — see lib/payoutHold.ts's header comment), but it can still be
  // the STORED reason on a row parked before then, and such a row must stay
  // held for a human exactly like any other legacy substantive finding.
  for (const storedReason of ["tier-hold", "provisional-shop", "photo-verdict"]) {
    assert.equal(
      shouldSweepReleaseHeldPayout({ leg: "delivery", storedReason, paused: false, holdDelivery: false }),
      false,
      `${storedReason} must stay held for a human`,
    );
  }
});

test("an accept-leg hold is never swept — delivery-gate cannot be its reason", () => {
  assert.equal(
    shouldSweepReleaseHeldPayout({ leg: "accept", storedReason: "provisional-shop", paused: false, holdDelivery: false }),
    false,
  );
});

test("a missing or unrecognised stored reason is treated as substantive, not released", () => {
  assert.equal(
    shouldSweepReleaseHeldPayout({ leg: "delivery", storedReason: null, paused: false, holdDelivery: false }),
    false,
  );
  assert.equal(
    shouldSweepReleaseHeldPayout({ leg: "delivery", storedReason: undefined, paused: false, holdDelivery: false }),
    false,
  );
});

// --- the kill-switch read itself: fail closed --------------------------------
//
// lib/payout.ts::settings() feeds every payout-touching call (issue, release,
// retry, sweep) through resolvePaymentsPaused. If the app_settings read fails,
// treating that as "not paused" would let money move during exactly the kind
// of outage that motivates reaching for the kill switch in the first place.

test("a failed settings read is treated as paused, regardless of the stale column value", () => {
  assert.equal(resolvePaymentsPaused(false, true), true); // stale row said not-paused, but the read itself failed
  assert.equal(resolvePaymentsPaused(true, true), true);
  assert.equal(resolvePaymentsPaused(undefined, true), true);
  assert.equal(resolvePaymentsPaused(null, true), true);
});

test("a successful settings read is trusted as-is", () => {
  assert.equal(resolvePaymentsPaused(true, false), true);
  assert.equal(resolvePaymentsPaused(false, false), false);
  assert.equal(resolvePaymentsPaused(undefined, false), false); // column unset → resting state, not paused
  assert.equal(resolvePaymentsPaused(null, false), false);
});
