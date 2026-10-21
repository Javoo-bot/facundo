"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/florist/LocaleProvider";

// Live countdown to an offer's binding expiry. When it lapses, the wave engine
// hands the order to the next florist — so this is an honest "respond by" clock,
// not decoration. Renders nothing if there's no expiry set.
export default function OfferCountdown({
  expiresAt,
}: {
  expiresAt: string | null;
  /** The window ran out but the order is still unclaimed, so this florist can
   *  take it anyway (lib/lateAccept.ts). Changes the zero state from a dead-end
   *  "expired" to an honest "you can still accept" — without it the badge would
   *  contradict the Accept button sitting right next to it. */
}) {
  const { t } = useT();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!expiresAt || now == null) return null;
  const msLeft = new Date(expiresAt).getTime() - now;

  // A LAPSED WINDOW SAYS NOTHING. This used to render either "your response
  // window has passed, but nobody has taken this order yet" or "Offer expired,
  // passing to the next florist" — and the second one was shown to the florist
  // even when they could still accept, because `stillAcceptable` was only true
  // once the ASSIGNMENT status had flipped to `expired`; a lapsed-but-still-
  // `sent` offer got an Accept button and "passing to the next florist" on the
  // same screen.
  //
  // Neither line is true any more: accepting runs until another florist takes
  // the order (lib/lateAccept.ts), so an elapsed window costs nothing. Telling
  // someone their chance has gone, next to a button that says otherwise, only
  // talks them out of a delivery we want.
  if (msLeft <= 0) return null;

  const mins = Math.round(msLeft / 60_000);
  const urgent = mins <= 15;
  const label = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return (
    <div className={`badge ${urgent ? "badge-warn" : "badge-neutral"}`} style={{ width: "fit-content" }}>
      {t("ui.offer.countdown.respondWithin", { label })}
    </div>
  );
}
