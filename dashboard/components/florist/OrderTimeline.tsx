"use client";

import type { OrderAssignment } from "@/lib/types";
import { useT } from "@/components/florist/LocaleProvider";

type NodeState = "done" | "current" | "upcoming";

interface TLNode { key: string; label: string; at: string | null; state: NodeState }

function fmt(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// A florist-facing, honest progression of THIS order through the steps the
// florist lives: offered → accepted → preparing & delivering → delivered. Every
// timestamp is a real one off the assignment (no fabricated "in progress" times);
// the active step is derived from the assignment's own status so it always agrees
// with the buttons above it.
export default function OrderTimeline({ assignment }: { assignment: OrderAssignment }) {
  const { t } = useT();
  const st = assignment.status;
  const offeredAt = assignment.sent_at ?? assignment.assigned_at ?? null;
  const acceptedAt = assignment.accepted_at ?? null;
  const deliveredAt = assignment.delivered_at ?? null;

  const isDelivered = st === "delivered";
  const isAccepted = st === "accepted" || isDelivered;

  const nodes: TLNode[] = [
    { key: "offered", label: t("ui.orderDetail.timeline.offerReceived"), at: offeredAt, state: isAccepted ? "done" : "current" },
    { key: "accepted", label: t("ui.orderDetail.timeline.youAccepted"), at: acceptedAt, state: isDelivered ? "done" : isAccepted ? "done" : "upcoming" },
    {
      key: "fulfilling",
      label: t("ui.orderDetail.timeline.preparingDelivering"),
      at: null,
      state: isDelivered ? "done" : isAccepted ? "current" : "upcoming",
    },
    { key: "delivered", label: t("ui.orderDetail.timeline.delivered"), at: deliveredAt, state: isDelivered ? "done" : "upcoming" },
  ];

  const dot = (s: NodeState) =>
    s === "done" ? "var(--ok, #2e7d32)" : s === "current" ? "var(--brand, #b1006b)" : "var(--ink-faint)";

  return (
    <div className="ocard" style={{ display: "grid", gap: 0 }}>
      <div className="mini-h" style={{ marginBottom: 8 }}>{t("ui.orderDetail.timeline.orderProgress")}</div>
      {nodes.map((n, i) => {
        const last = i === nodes.length - 1;
        return (
          <div key={n.key} style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span
                aria-hidden
                style={{
                  width: 11, height: 11, borderRadius: "50%", background: dot(n.state),
                  boxShadow: n.state === "current" ? "0 0 0 3px color-mix(in srgb, var(--brand, #b1006b) 25%, transparent)" : "none",
                  marginTop: 3,
                }}
              />
              {!last && <span style={{ flex: 1, width: 2, background: n.state === "done" ? "var(--ok, #2e7d32)" : "var(--line, #e5e5e5)", minHeight: 22 }} />}
            </div>
            <div style={{ paddingBottom: last ? 0 : 12 }}>
              <div style={{ fontSize: ".85rem", color: n.state === "upcoming" ? "var(--ink-faint)" : "var(--ink)", fontWeight: n.state === "current" ? 600 : 400 }}>
                {n.label}
              </div>
              {n.at && <div style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>{fmt(n.at)}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
