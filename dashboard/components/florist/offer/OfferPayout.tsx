"use client";

import { useT } from "@/components/florist/LocaleProvider";
import { euro } from "@/components/florist/orderFormat";

export interface PayoutSplit {
  total: number | null;
  accept: number;
  delivery: number;
  acceptPct: number;
  deliveryPct: number;
  hold: boolean;
  photoRequired: boolean;
  /** This shop's tier pays the whole payout on accept (delivery leg = 0%).
   *  Derived server-side from the tier via lib/payoutMath.ts::isSinglePayment,
   *  never from a tier code here. */
  singlePayment: boolean;
  tierLabel: string | null;
}

/** How the money actually arrives, spelled out AT DECISION TIME.
 *
 * The percentages are NEVER hardcoded. They come from this florist's
 * `trust_tier` (`split_on_accept` / `split_on_delivery`) via
 * lib/payoutMath.ts::computeSplit, resolved server-side on the order page — so
 * a florist on a different split reads their own numbers, not a marketing
 * default. The `hold_payout` / `photo_required` notes still append when their
 * tier sets them.
 *
 * TWO SHAPES, because a shop paid in full has a genuinely different deal and
 * showing it the two-leg layout with "€0.00 · 0% once your delivery photo
 * clears" would be worse than useless:
 *
 *   - split (the default): two rows, accept + photo, each with its own figure.
 *   - single payment (`singlePayment`, i.e. a 0% delivery leg): ONE row for the
 *     whole amount, plus a separate line making the photo obligation explicit.
 *
 * That second line is the load-bearing part of this component. These shops
 * still owe us a delivery photo — it is how we know the flowers arrived, and it
 * is what the customer's "delivered" email carries — it just isn't holding
 * their money any more. Saying "you're paid in full" and leaving the photo
 * unmentioned would read as "no photo needed", which is the one wrong
 * conclusion this whole change must not produce.
 *
 * "flowers, add-ons and delivery included" is literally true rather than
 * reassurance: computePayoutPrice(orderTotal, percent). */
export default function OfferPayout({ split }: { split: PayoutSplit | null }) {
  const { t } = useT();
  if (!split) return null;
  const { total, accept, delivery, acceptPct, deliveryPct, hold, photoRequired, singlePayment } = split;

  if (singlePayment) {
    return (
      <div className="ocard" style={{ display: "grid", gap: 10 }}>
        {/* Same heading either way: "How we pay you for this order" is true of
            one payment and of two. */}
        <div className="fc-offer-h">{t("ui.offer.page.payTitle")}</div>
        <div style={{ fontSize: ".95rem", color: "var(--ink)" }}>
          {t("ui.offer.page.payTotal", { total: euro(total) })}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <b style={{ fontSize: "1rem", color: "var(--accent-ink)", minWidth: 72 }}>{euro(accept)}</b>
          <span style={{ fontSize: ".85rem", color: "var(--ink-soft)" }}>
            <b style={{ color: "var(--ink)" }}>{acceptPct}%</b> {t("ui.offer.page.payOnAcceptFull")}
          </span>
        </div>
        {photoRequired && (
          <div style={{ fontSize: ".76rem", color: "var(--ink-faint)", lineHeight: 1.4 }}>
            {t("ui.offer.payout.photoStillRequiredNote")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="ocard" style={{ display: "grid", gap: 10 }}>
      <div className="fc-offer-h">{t("ui.offer.page.payTitle")}</div>
      <div style={{ fontSize: ".95rem", color: "var(--ink)" }}>
        {t("ui.offer.page.payTotal", { total: euro(total) })}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <b style={{ fontSize: "1rem", color: "var(--accent-ink)", minWidth: 72 }}>{euro(accept)}</b>
          <span style={{ fontSize: ".85rem", color: "var(--ink-soft)" }}>
            <b style={{ color: "var(--ink)" }}>{acceptPct}%</b> {t("ui.offer.page.payOnAccept")}
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <b style={{ fontSize: "1rem", color: "var(--accent-ink)", minWidth: 72 }}>{euro(delivery)}</b>
          <span style={{ fontSize: ".85rem", color: "var(--ink-soft)" }}>
            <b style={{ color: "var(--ink)" }}>{deliveryPct}%</b> {t("ui.offer.page.payOnPhoto")}
          </span>
        </div>
      </div>
      {(hold || photoRequired) && (
        <div style={{ fontSize: ".76rem", color: "var(--ink-faint)", lineHeight: 1.4 }}>
          {photoRequired && <>{t("ui.offer.payout.photoRequiredNote")} </>}
          {hold && <>{t("ui.offer.payout.holdNote")}</>}
        </div>
      )}
    </div>
  );
}
