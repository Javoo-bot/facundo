"use client";

// Shared building blocks for every /statistics section (Tasks 12-14). Colors
// are drawn from design-system.css's custom properties (not hardcoded hex) so
// charts stay correct in both themes — see the dataviz skill: categorical
// hues are assigned in this fixed order and never cycled or reassigned when a
// filter changes which series are present.
export const CHART_COLORS = ["var(--accent)", "var(--bloom)", "var(--warn)", "var(--crit)", "var(--ok)"];

export function StatTile({ label, value, sublabel }: { label: string; value: string; sublabel?: string }) {
  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 4 }}>
      <span style={{ color: "var(--ink-faint)", font: "600 .68rem/1 var(--mono)", letterSpacing: ".08em", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: "1.6rem", fontWeight: 600, color: "var(--ink)" }}>{value}</span>
      {sublabel && <span style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>{sublabel}</span>}
    </div>
  );
}

export function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <h3 style={{ fontSize: ".9rem", fontWeight: 600, color: "var(--ink)" }}>{title}</h3>
      {children}
    </div>
  );
}

/** Honest empty state for a chart with no rows in the current range — the dev
 * DB has very little data, so this is the common case, not the edge case.
 * Renders in place of the chart itself (never an empty axes shell, which
 * reads as broken rather than "nothing here"). */
export function ChartEmpty({ label = "No data in this range." }: { label?: string }) {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        height: 120,
        border: "1px dashed var(--line)",
        borderRadius: 8,
        color: "var(--ink-faint)",
        fontSize: ".82rem",
      }}
    >
      {label}
    </div>
  );
}
