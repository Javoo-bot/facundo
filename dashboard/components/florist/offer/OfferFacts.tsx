"use client";

import { useT } from "@/components/florist/LocaleProvider";
import { euro, fmtKm, fmtDeliverBy } from "@/components/florist/orderFormat";

/** The three numbers a florist decides on, plus where it's going.
 *
 * Deliberately tiles rather than a sentence: distance, deadline and money
 * should be readable at a glance, not parsed out of prose.
 *
 * THE ADDRESS STAYS GATED. `view.address` and `view.recipient` are nulled
 * server-side until the florist accepts (app/florist/(app)/orders/[id]/page.tsx
 * — "PII: revealed only after accept"), so this renders the delivery AREA plus
 * the distance we derived. That's enough to judge the job, and it means a
 * customer's address never reaches a florist who goes on to decline.
 *
 * `occasion` and `delivery_window` used to render here conditionally. Both are
 * null on all 1000 sampled production orders, so they never appeared; they are
 * not carried over. */
export default function OfferFacts({
  area,
  distanceKm,
  deliveryAt,
  payout,
}: {
  area: string | null;
  distanceKm: number | null;
  deliveryAt: string | null;
  payout: number | null;
}) {
  const { t } = useT();
  const { day, time } = fmtDeliverBy(deliveryAt, t);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="fc-facts">
        <div className="fc-fact">
          <div className="fc-fact-l">{t("ui.offer.page.factAway")}</div>
          <div className="fc-fact-v">{distanceKm != null ? fmtKm(distanceKm) : "—"}</div>
        </div>
        <div className="fc-fact">
          <div className="fc-fact-l">{t("ui.offer.page.factDeliverBy")}</div>
          <div className="fc-fact-v">
            {day}
            {time && <small>{time}</small>}
          </div>
        </div>
        <div className="fc-fact accent">
          <div className="fc-fact-l">{t("ui.offer.page.factYouEarn")}</div>
          <div className="fc-fact-v">{euro(payout)}</div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 2 }}>
        <div className="fc-addr">📍 {area ?? "—"}</div>
        <div className="fc-addr-hint">{t("ui.offer.page.fullAddressOnAccept")}</div>
      </div>
    </div>
  );
}
