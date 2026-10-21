"use client";
import Link from "next/link";
import type { Payout } from "@/lib/types";
import { computeBalance } from "@/lib/payoutBalance";
import { legLabel } from "@/components/florist/floristOps";
import FloristEarnings from "@/components/florist/FloristEarnings";
import CardReveal from "@/components/florist/CardReveal";
import type { Earnings } from "@/lib/floristStanding";
import { useT } from "@/components/florist/LocaleProvider";

// A payout you can tap through to reveal + charge a virtual card. Mirrors the
// gate on the payment page (rail=card, a real card ref, live status).
function hasCard(p: Payout): boolean {
  return (
    p.rail === "card" &&
    !!p.provider_ref &&
    !String(p.provider_ref).startsWith("ledger:") &&
    (p.status === "issued" || p.status === "paid")
  );
}

export default function FloristBalance({
  payouts,
  earnings,
  completedCount,
  standing,
}: {
  payouts: Payout[];
  earnings?: Earnings;
  completedCount?: number;
  standing?: { label: string; blurb: string };
}) {
  // Net balance — includes clawed_back (negative) rows so a clawback actually
  // reduces the shown balance (see lib/payoutBalance.ts).
  const balance = computeBalance(payouts);
  const cardCount = payouts.filter(hasCard).length;
  const { t } = useT();

  return (
    <main className="ds page fc-readable">
      <h1>{t("ui.balance.title")}</h1>
      {earnings && standing && (
        <div style={{ marginTop: 12 }}>
          <FloristEarnings earnings={earnings} completedCount={completedCount ?? 0} standing={standing} />
        </div>
      )}
      <div className="ocard" style={{ marginTop: 12 }}>
        <b style={{ fontSize: "1.4rem" }}>€{balance.toFixed(2)}</b>
        <p style={{ color: "var(--ink-soft)", fontSize: ".82rem", marginTop: 4 }}>
          {cardCount > 0
            ? t("ui.balance.cardHelperWithCards")
            : t("ui.balance.cardHelperNoCards")}
        </p>
      </div>
      <div className="mini-h" style={{ marginTop: 16 }}>{t("ui.balance.transactionsHeading")}</div>
      {payouts.length === 0 && (
        <p style={{ color: "var(--ink-faint)", fontSize: ".85rem" }}>{t("ui.balance.noPayouts")}</p>
      )}
      {payouts.map((p) => {
        // accept/delivery keep their translated labels (this is the localized
        // florist PWA). `manual` has no translation because it can't reach a
        // florist — the payouts RLS policy is assignment-scoped, so an
        // order-less leg is never selectable here — so it falls back to the
        // shared helper rather than being silently mislabelled "On delivery".
        const legText = p.leg === "manual"
          ? legLabel(p.leg)
          : p.leg === "accept" ? t("ui.balance.legAccept") : t("ui.balance.legDelivery");
        const card = hasCard(p);
        // The row still leads to the payment record (status, order, detail).
        // But the CARD itself now gets a real button that reveals it right
        // here — it used to be a 0.72rem accent caption inside the row, which
        // asked the florist to guess the row was tappable and then tap again
        // on the payment page before seeing any card.
        return (
          <div key={p.id} style={{ display: "grid", gap: 8 }}>
            <Link href={`/florist/payments/${p.id}`} className="tx" style={{ cursor: "pointer" }}>
              <span>{legText} · {p.status}</span>
              <b>€{(p.amount ?? 0).toFixed(2)}</b>
            </Link>
            {card && <CardReveal payoutId={p.id} />}
          </div>
        );
      })}
    </main>
  );
}
