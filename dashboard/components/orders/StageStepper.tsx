"use client";
import { STAGES, type StageId } from "@/lib/orderStages";

// Horizontal journey stepper for the order page: Order received → Florists found
// → Offer sent → Order accepted → On the way → Delivered. `current` is the
// derived display stage (never the escalated/cancelled overlays — those are
// passed as flags). The words live in lib/orderStages.ts; this file draws them.
export default function StageStepper({
  current,
  escalated = false,
  cancelled = false,
  issueCount = 0,
}: {
  current: StageId;
  escalated?: boolean;
  cancelled?: boolean;
  issueCount?: number;
}) {
  const curIdx = STAGES.findIndex((s) => s.id === current);
  const flagged = escalated || issueCount > 0;

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 0, overflowX: "auto" }}>
        {STAGES.map((s, i) => {
          const state = cancelled && i > curIdx ? "dropped" : i < curIdx ? "done" : i === curIdx ? "current" : "upcoming";
          const isCurrent = state === "current";
          const dotColor =
            state === "done" ? "var(--ok)"
              : isCurrent ? (flagged ? "var(--warn)" : "var(--accent)")
              : state === "dropped" ? "var(--crit)"
              : "var(--line-strong)";
          const glyph = state === "done" ? "✓" : isCurrent ? (flagged ? "!" : "●") : "○";
          return (
            <div key={s.id} style={{ display: "flex", alignItems: "center", flex: i < STAGES.length - 1 ? 1 : "0 0 auto", minWidth: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, minWidth: 64 }}>
                <span
                  aria-hidden="true"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, borderRadius: "50%",
                    border: `2px solid ${dotColor}`,
                    background: isCurrent ? dotColor : "var(--surface)",
                    color: isCurrent ? "var(--surface)" : dotColor,
                    fontSize: ".7rem", fontWeight: 700,
                    boxShadow: isCurrent ? `0 0 0 4px color-mix(in srgb, ${dotColor} 18%, transparent)` : undefined,
                  }}
                >
                  {glyph}
                </span>
                <span
                  style={{
                    fontSize: ".72rem", fontWeight: isCurrent ? 700 : 500, textAlign: "center",
                    color: isCurrent ? "var(--ink)" : state === "done" ? "var(--ink-soft)" : "var(--ink-faint)",
                    textDecoration: state === "dropped" ? "line-through" : undefined,
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.label}
                </span>
              </div>
              {i < STAGES.length - 1 && (
                <span
                  aria-hidden="true"
                  style={{ flex: 1, height: 2, margin: "0 4px", marginBottom: 18, minWidth: 16, background: i < curIdx ? "var(--ok)" : "var(--line-strong)" }}
                />
              )}
            </div>
          );
        })}
      </div>
      {(cancelled || flagged) && (
        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {cancelled && <span className="badge badge-crit">Cancelled</span>}
          {escalated && <span className="badge badge-crit">Escalated</span>}
          {issueCount > 0 && <span className="badge badge-warn">⚠ {issueCount} open issue{issueCount > 1 ? "s" : ""}</span>}
        </div>
      )}
    </div>
  );
}
