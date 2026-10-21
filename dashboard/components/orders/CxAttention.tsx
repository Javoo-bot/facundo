"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { CxAttentionRow, CxCategory } from "@/lib/cxAttention";
import EmptyState from "@/components/EmptyState";
import { IconCheckCircle } from "@/components/icons";
import SlaDot from "@/components/ui/SlaDot";

// badgeCls maps to the shared .badge-* classes in design-system.css. `--brand`
// isn't a defined token — `--tB` (bloom) is the closest existing match for
// that magenta, hence badge-bloom for "approval".
const CAT_META: Record<CxCategory, { short: string; badgeCls: string }> = {
  approval: { short: "Approve", badgeCls: "badge-bloom" },
  place: { short: "Place", badgeCls: "badge-warn" },
  message: { short: "Msg", badgeCls: "badge-accent" },
  delivery: { short: "Deliv", badgeCls: "badge-bloom" },
  money: { short: "$", badgeCls: "badge-crit" },
};

function catChip(cat: CxCategory) {
  const m = CAT_META[cat];
  return <span className={`badge ${m.badgeCls}`}>{m.short}</span>;
}

function overdueLabel(iso: string | null): string | null {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins}m overdue`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m overdue`;
}

type Filter = CxCategory | "all";

export default function CxAttention({ rows }: { rows: CxAttentionRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length, approval: 0, place: 0, message: 0, delivery: 0, money: 0 };
    for (const r of rows) for (const cat of r.categories) c[cat] = (c[cat] ?? 0) + 1;
    return c;
  }, [rows]);

  const filtered = filter === "all" ? rows : rows.filter((r) => r.categories.includes(filter));

  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "approval", label: "Approvals" },
    { key: "place", label: "Place" },
    { key: "message", label: "Messages" },
    { key: "delivery", label: "Delivery" },
    { key: "money", label: "Money" },
  ];

  return (
    <main className="ds page">
      <p className="eyebrow">Backoffice · CX</p>
      <h1>Attention {rows.length > 0 && <span style={{ color: "var(--ink-soft)", fontWeight: 400 }}>· {rows.length}</span>}</h1>
      <p style={{ color: "var(--ink-soft)", fontSize: ".9rem", marginTop: 4, maxWidth: "48rem" }}>
        Everything that needs a human — unplaceable orders, stalling offers, florist issues &amp; messages, late deliveries,
        disputes and payment problems. Most urgent first; click a row to handle it on the order.
      </p>

      <div className="filterbar" style={{ margin: "14px 0" }}>
        {chips.map((c) => {
          const on = filter === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={`filter-trigger${on ? " on" : ""}`}
            >
              {c.label} <span className="count">{counts[c.key] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="data-table">
          <thead>
            <tr><th style={{ width: 24 }}></th><th>Order</th><th>Reason</th><th>Deliver</th><th>SLA</th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const od = overdueLabel(r.primary.slaAt);
              return (
                <tr key={r.orderId} onClick={() => { location.href = `/orders/${r.orderId}`; }} style={{ cursor: "pointer" }}>
                  <td>{r.unread && <span aria-label="unread" style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--crit)" }} />}</td>
                  <td>
                    <Link href={`/orders/${r.orderId}`} onClick={(e) => e.stopPropagation()} style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>
                      {r.orderName ?? r.orderId.slice(0, 8)}
                    </Link>
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {catChip(r.primary.category)}
                      <span>{r.primary.label}</span>
                      {r.others.length > 0 && <span style={{ color: "var(--ink-faint)", fontSize: ".78rem" }}>+{r.others.length} more</span>}
                      {od && <span style={{ color: "var(--crit)", fontSize: ".78rem" }}>· {od}</span>}
                    </span>
                  </td>
                  <td style={{ color: "var(--ink-soft)" }}>{r.deliveryAt ? new Date(r.deliveryAt).toLocaleString() : "—"}</td>
                  <td>
                    {r.primary.slaAt
                      ? <SlaDot deadlineIso={r.primary.slaAt} label={new Date(r.primary.slaAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
                      : "—"}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 0 }}>
                  <EmptyState
                    icon={<IconCheckCircle className="h-12 w-12 text-ink-faint" />}
                    title="Nothing needs attention"
                    description="No unplaceable orders, stalled offers, florist issues, late deliveries, or payment problems right now."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
