"use client";
import Link from "next/link";
import type { AssignmentStatus, OrderStatus } from "@/lib/orderStatus";
import { useAcceptOffer } from "@/components/florist/useAcceptOffer";
import AcceptOfferFeedback from "@/components/florist/AcceptOfferFeedback";
import { useT } from "@/components/florist/LocaleProvider";

export type HistoryRow = {
  id: string;
  status: AssignmentStatus;
  payout_price: number | null;
  assigned_at: string;
  orders: { order_name: string | null; delivery_at: string | null; status: OrderStatus } | null;
};

const OPEN_ORDER_STATUSES: OrderStatus[] = ["received", "matched", "reaching_out"];

function euro(n: number | null): string {
  return n != null ? `€${n.toFixed(2)}` : "—";
}
function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function statusBadge(row: HistoryRow, t: (key: string) => string): { cls: string; label: string } {
  switch (row.status) {
    case "declined":
      return { cls: "badge-warn", label: t("ui.history.status.declined") };
    case "expired":
      return { cls: "badge-crit", label: t("ui.history.status.expired") };
    case "reassigned":
      return { cls: "badge-neutral", label: t("ui.history.status.reassigned") };
    case "released":
      return { cls: "badge-neutral", label: t("ui.history.status.released") };
    case "delivered":
      return { cls: "badge-accent", label: t("ui.history.status.delivered") };
    case "accepted":
      return row.orders?.status === "cancelled"
        ? { cls: "badge-crit", label: t("ui.history.status.cancelled") }
        : { cls: "badge-accent", label: t("ui.history.status.delivered") };
    default:
      return { cls: "badge-neutral", label: row.status };
  }
}

/** A single history row that may offer a "changed your mind? accept" button
 * — declined assignments whose order hasn't been taken by anyone else yet.
 * Owns its own accept-offer state so one row's feedback/busy state never
 * bleeds into another's. */
function HistoryRowItem({ row }: { row: HistoryRow }) {
  const { t } = useT();
  const badge = statusBadge(row, t);
  const canReAccept = row.status === "declined" && !!row.orders?.status && OPEN_ORDER_STATUSES.includes(row.orders.status);
  const { result, accept } = useAcceptOffer();

  return (
    <div className="ocard" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <Link href={`/florist/orders/${row.id}`} style={{ fontWeight: 700 }}>{row.orders?.order_name ?? "—"}</Link>
          <div style={{ color: "var(--ink-soft)", fontSize: ".8rem", marginTop: 2 }}>{dateLabel(row.orders?.delivery_at ?? null)}</div>
        </div>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
      </div>
      <div className="payout"><span>{t("ui.history.payout")}</span><b>{euro(row.payout_price)}</b></div>
      {canReAccept && result.kind !== "success" && (
        <button type="button" className="btn" disabled={result.kind === "busy"} onClick={() => accept(row.id)}>
          {result.kind === "busy" ? t("ui.history.accepting") : t("ui.history.changedMindAccept")}
        </button>
      )}
      <AcceptOfferFeedback result={result} />
    </div>
  );
}

export default function FloristHistory({ rows }: { rows: HistoryRow[] }) {
  const { t } = useT();
  return (
    <main className="ds page fc-readable">
      <h1>{t("ui.history.title")}</h1>

      {rows.length === 0 ? (
        <p style={{ color: "var(--ink-faint)", marginTop: 12 }}>{t("ui.history.empty")}</p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
          {rows.map((row) => (
            <HistoryRowItem key={row.id} row={row} />
          ))}
        </div>
      )}
    </main>
  );
}
