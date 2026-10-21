"use client";

import { Hint, NumberField, PanelCard, Toggle } from "@/components/settings/fields";
import type { PanelProps } from "@/components/settings/types";

/**
 * The kill switch, the delivery-leg hold, and the florist's cut.
 *
 * OPERATOR RUNBOOK — `payments_paused` (the 🛑 toggle below):
 *   - Blocks every money-moving path: accept/delivery-leg issue, the manual
 *     payout API, held-payout release/approve, the failed-payout retry, and
 *     the unattended held-payout sweep cron (lib/payout.ts::sweepHeldPayouts).
 *     All six read the switch through the same lib/payout.ts::settings()
 *     helper, so flipping it takes effect everywhere on the next call — no
 *     restart needed.
 *   - A HELD payout (tier-hold, provisional-shop, or the delivery-gate switch
 *     above — photo-verdict holding is temporarily disabled as of 2026-08-20,
 *     see lib/payoutHold.ts) still gets its row CREATED while paused —
 *     that just records the entitlement, it reserves no money — but it can
 *     never be RELEASED while paused, whether by a human approving it or the
 *     sweep cron auto-releasing a stale delivery-gate hold.
 *   - Fails CLOSED: if the settings read itself fails (DB blip, outage), that
 *     is treated as paused, not as "not paused" — an unreadable kill switch
 *     must never silently mean money keeps moving. See
 *     lib/payoutHold.ts::resolvePaymentsPaused.
 *   - Does not touch test/demo shops (`florists.is_test_shop`) — those never
 *     get a real card regardless of this switch or `payments_live`, via
 *     lib/payoutMath.ts::effectivePaymentsLive.
 */
export default function PaymentsPanel({ form, set }: PanelProps) {
  return (
    <div className="space-y-5">
      <PanelCard title="Payments" tone={form.payments_paused ? "crit" : "normal"}>
        <div className="space-y-3">
          <Toggle
            label="🛑 Pause all payments (kill switch)"
            checked={form.payments_paused}
            onChange={(v) => set("payments_paused", v)}
            danger
            hint="When on, no card is issued or released — accept and delivery legs both defer. Flip this in an incident."
          />
          <Toggle
            label="Hold the 30% delivery leg for CX approval"
            checked={form.hold_delivery_payouts}
            onChange={(v) => set("hold_delivery_payouts", v)}
            hint="Off by default: a delivered photo releases the 30% straight away. The AI photo check still runs and records its verdict (visible on the order page) but does not currently hold anything on its own — its calibration isn't trusted yet. Turn this on to put every delivery back in the CX queue by hand."
          />
        </div>
      </PanelCard>

      <PanelCard title="Florist payout share">
        <NumberField
          label="Payout share"
          labelWidth="w-44"
          value={form.default_payout_percent}
          onChange={(v) => set("default_payout_percent", v)}
          min={0}
          max={100}
          unit="% of the order total (incl. shipping)"
        />
        <Hint>
          What we offer the florist, e.g. 55% means we keep the remaining 45%. Locked in per order at match
          time — changing this only affects orders matched from now on.
        </Hint>
      </PanelCard>
    </div>
  );
}
