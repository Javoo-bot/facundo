"use client";
import type { Earnings } from "@/lib/floristStanding";
import { useT } from "@/components/florist/LocaleProvider";

function euro(n: number): string {
  return `€${n.toFixed(2)}`;
}

// The florist's at-a-glance standing + earnings, above the transaction ledger:
// what they've been paid, what's on the way, how many orders they've completed,
// and what their trust standing means for when they get paid.
export default function FloristEarnings({
  earnings,
  completedCount,
  standing,
}: {
  earnings: Earnings;
  completedCount: number;
  standing: { label: string; blurb: string };
}) {
  const { t } = useT();
  return (
    <div className="ocard" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div>
          <div className="mini-h">{t("ui.earnings.standing")}</div>
          <div style={{ fontWeight: 600 }}>{standing.label}</div>
        </div>
        <span className="badge badge-neutral" style={{ whiteSpace: "nowrap" }}>
          {completedCount === 1
            ? t("ui.earnings.ordersDeliveredOne", { count: completedCount })
            : t("ui.earnings.ordersDeliveredOther", { count: completedCount })}
        </span>
      </div>
      <div style={{ fontSize: ".78rem", color: "var(--ink-faint)", lineHeight: 1.4, marginTop: -4 }}>{standing.blurb}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>{t("ui.earnings.paidOut")}</span>
          <b style={{ fontSize: "1.1rem" }}>{euro(earnings.paidOut)}</b>
        </div>
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>{t("ui.earnings.onTheWay")}</span>
          <b style={{ fontSize: "1.1rem" }}>{euro(earnings.inProgress)}</b>
        </div>
      </div>
    </div>
  );
}
