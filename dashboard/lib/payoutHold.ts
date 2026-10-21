// Whether a payout leg releases now or parks as `held` for a human.
//
// Pulled out of lib/payout.ts::issueLeg so the rule can be read in one place and
// exercised by `node --test` — the condition it replaces was a five-clause
// boolean inside an I/O function, which is a poor place for the decision that
// governs whether real money moves.
//
// THE POLICY (changed 2026-08-10): a florist ACCEPTING an order and a florist
// UPLOADING A DELIVERY PHOTO are self-approving events. Neither waits for a
// human, and — the point of the change — that is true in `semi` mode too.
// Workflow mode gates system-initiated steps (who we offer to, what we write
// back to Shopify); it no longer gates paying a florist who has done the work.
// Before this, `semi` held BOTH legs and any non-`auto` mode held the delivery
// leg, so in practice every payout on the live account queued behind CX.
//
// What still holds is a SUBSTANTIVE FINDING about this florist, never a
// workflow step:
//
//   tier-hold        the trust tier itself says hold (tier 4 — untrusted)
//   provisional-shop a cold-offer shop that joined by accepting, above the
//                    auto-pay cap: no history, no vetting, a self-declared
//                    address (lib/coldOffer.ts::shouldHoldAcceptLeg)
//   delivery-gate    an operator has explicitly switched the 30% back to manual
//                    release (app_settings.hold_delivery_payouts)
//
// PHOTO-VERDICT HOLDING IS DISABLED (as of 2026-08-20). The AI photo check
// (lib/photoVerify/) still runs on every delivery and still writes its verdict
// to `photo_verifications` — that data feeds a florist-facing review UI a
// frontend engineer is building in parallel, and will be needed to re-tune the
// agent — but a `review`/`fail` verdict no longer parks the 30% for CX. An
// audit of every row ever written (5 total; the feature is new) found all 5
// were `review`, none `pass`, none `fail` — and two of them (orders #2000008
// and #2000001, both 2026-07-26) were photos of Birkenstock shoe boxes on a
// couch, not floral photos at all, that the agent still scored `review`
// instead of failing hard. That calibration isn't trustworthy enough yet to
// gate real florist payouts on, so only the HOLD consequence is off — the
// check itself (lib/photoVerify/) is untouched, and improving its judgment is
// a separate piece of work. Revisit once the agent's calibration is re-tuned.

export type PayoutLeg = "accept" | "delivery" | "manual";

/** Why a leg was parked. `null` means it releases now. Values are written to
 *  `payment_events.payload.reason`, so they are stable strings, not prose. */
export type PayoutHoldReason =
  | "tier-hold"
  | "provisional-shop"
  | "delivery-gate";

export interface PayoutHoldInput {
  leg: PayoutLeg;
  /** The staff "release without photo" override — a human is authorising this
   *  by hand, so every gate below is skipped. */
  force?: boolean;
  /** `trust_tiers.hold_payout` for this florist's tier. */
  tierHold?: boolean;
  /** shouldHoldAcceptLeg() — already false for anything but a provisional shop. */
  provisionalHold?: boolean;
  /** app_settings.hold_delivery_payouts. Defaults to false: the operator's
   *  manual "hold the 30% for review anyway" override. */
  holdDelivery?: boolean;
}

/**
 * The single hold decision. Order matters only for which reason is reported
 * when several apply; any one of them holds.
 */
export function payoutHoldReason(input: PayoutHoldInput): PayoutHoldReason | null {
  const { leg, force, tierHold, provisionalHold, holdDelivery } = input;
  if (force) return null;

  if (tierHold) return "tier-hold";
  // Accept-leg only. Before 2026-08-20 the delivery leg was ALSO gated by a
  // photo-verdict hold, so an unvetted shop that delivered and proved it had a
  // second check on the way out; with that hold disabled (see the header
  // comment) this is now the only gate on a provisional shop's delivery leg,
  // and the rule stays as it was: having delivered and proved it, the shop is
  // not re-blocked on money it already earned.
  if (leg === "accept" && provisionalHold) return "provisional-shop";

  if (leg === "delivery" && holdDelivery) return "delivery-gate";
  return null;
}

// --- unattended release sweep -------------------------------------------------
//
// A HELD row has no release surface today short of a human calling the approve
// API by hand (the UI that would render it was never mounted — see /lifecycle,
// payout-accept). Of the three reasons above, two (tier-hold, provisional-shop)
// are a substantive finding about the florist and must stay parked for a
// person — that is what "held" is FOR. `delivery-gate` is the one exception: it
// is not a finding at all, it is the operator's own workflow switch, and once
// they flip it back off every NEW delivery leg releases on its own. A row held
// while the switch was on is just a stale artifact of that switch — nothing
// about the florist says wait — so it should release itself the same way,
// rather than sit forever waiting for someone to notice.
//
// A row still bearing the legacy `photo-verdict` reason (parked before
// 2026-08-20, when that hold was disabled — see the header comment) is treated
// the same as any other substantive finding below: never auto-swept. It is a
// pre-existing park, not a stale switch, and stays for a human.
export interface HeldPayoutSweepInput {
  leg: PayoutLeg;
  /** `payment_events.payload.reason` recorded when this row was parked. Can
   *  still be the legacy `"photo-verdict"` string on a row parked before that
   *  hold was disabled (2026-08-20) — see the header comment. */
  storedReason: string | null | undefined;
  /** app_settings.payments_paused — the global kill switch always wins. */
  paused: boolean;
  /** Current app_settings.hold_delivery_payouts. */
  holdDelivery: boolean;
}

/** Whether an already-HELD payout is safe to release unattended, right now. */
export function shouldSweepReleaseHeldPayout(input: HeldPayoutSweepInput): boolean {
  const { leg, storedReason, paused, holdDelivery } = input;
  if (paused) return false; // kill switch: never release while payments are shut down
  if (leg !== "delivery") return false; // delivery-gate cannot be the accept leg's reason
  if (storedReason !== "delivery-gate") return false; // a substantive finding — stays for a human
  return !holdDelivery; // the switch that parked it is still on — leave it for the operator
}

// --- kill-switch read: fail CLOSED, not open ----------------------------------
//
// lib/payout.ts::settings() reads app_settings.payments_paused fresh on every
// payout-touching call (issue, release, retry, sweep). Every field it reads
// defaults to a SAFE value if the row can't be read — except payments_paused,
// where `false` (defaulting via `data?.payments_paused ?? false`) is the
// UNSAFE default: it means "not paused", i.e. money keeps moving. A read
// failure (DB blip, outage, the row missing) must not be silently read as
// permission to pay — that would mean the exact kind of incident that made an
// operator reach for the kill switch is also the kind of incident that can
// blind this check and let it through. Matches the fail-closed convention
// already used for the auth allow list (lib/allowlist.ts::isAllowed).
export function resolvePaymentsPaused(paused: boolean | null | undefined, readFailed: boolean): boolean {
  if (readFailed) return true; // can't confirm the switch is off → treat as on
  return paused ?? false; // row read fine, column just unset → default resting state
}
