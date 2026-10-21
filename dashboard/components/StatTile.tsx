import type { ReactNode } from "react";

// Accent covers the two static tiles (emerald for the geography trio +
// drafts, slate for the neutral florist count) plus every dynamic band name
// ratingBand()/coverageBand() can return, so StatTile can take either
// directly as `accent`.
export type TileAccent = "emerald" | "slate" | "indigo" | "green" | "lime" | "amber" | "red";

// Retinted onto the `.ds` token bridge (dashboard/tailwind.config.ts) —
// emerald-600/700 -> accent/accent-ink, slate-* -> ink/ink-soft/surface-2,
// indigo-* -> bloom, amber-* -> amber/warn, red-* -> crit. Callers must
// render StatTile inside a `.ds` ancestor for these utilities to resolve.
const ACCENT_CLASSES: Record<TileAccent, { border: string; iconBg: string; iconText: string }> = {
  emerald: { border: "border-b-accent", iconBg: "bg-surface-2", iconText: "text-accent-ink" },
  slate: { border: "border-b-ink-faint", iconBg: "bg-surface-2", iconText: "text-ink-soft" },
  indigo: { border: "border-b-bloom", iconBg: "bg-surface-2", iconText: "text-bloom" },
  green: { border: "border-b-ok", iconBg: "bg-surface-2", iconText: "text-ok" },
  lime: { border: "border-b-ok", iconBg: "bg-surface-2", iconText: "text-ok" },
  amber: { border: "border-b-amber", iconBg: "bg-surface-2", iconText: "text-amber" },
  red: { border: "border-b-crit", iconBg: "bg-surface-2", iconText: "text-crit" },
};

export default function StatTile({
  label,
  value,
  accent,
  icon,
}: {
  label: string;
  value: string | number;
  accent: TileAccent;
  icon: ReactNode;
}) {
  const classes = ACCENT_CLASSES[accent];
  return (
    <div
      className={`stat-tile rounded-lg border border-line bg-surface p-4 shadow-sm border-b-2 ${classes.border}`}
    >
      <div
        className={`mb-2 flex h-7 w-7 items-center justify-center rounded-md ${classes.iconBg} ${classes.iconText}`}
      >
        {icon}
      </div>
      <p className="text-2xl font-bold tabular-nums text-ink">{value}</p>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{label}</p>
    </div>
  );
}
