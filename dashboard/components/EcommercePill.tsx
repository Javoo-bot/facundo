import { ecommerceBand, type EcommerceBand } from "@/lib/bands";

// Ecommerce gets its own hue (bloom, the design system's secondary/"targeting
// attribute" accent — was indigo pre-retint) — it's a targeting attribute,
// not a pass/fail outcome, so intensity (not rating/coverage hues) carries
// the signal. Bands per the brief: solid >=60%, mid 30-59%, low 1-29%, none 0/null.
// Wash backgrounds are built with color-mix() since Tailwind's opacity
// modifier (`bg-bloom/10`) doesn't compile against the CSS-var color.
const PILL_CLASSES: Record<EcommerceBand, string> = {
  high: "bg-bloom text-white",
  mid: "text-bloom",
  low: "text-bloom",
  none: "bg-surface-2 text-ink-faint",
};

const WASH_OPACITY: Partial<Record<EcommerceBand, number>> = {
  mid: 16,
  low: 8,
};

export default function EcommercePill({ pct }: { pct: number | null }) {
  const band = ecommerceBand(pct);
  const washPct = WASH_OPACITY[band];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${PILL_CLASSES[band]}`}
      style={washPct != null ? { background: `color-mix(in srgb, var(--tB) ${washPct}%, transparent)` } : undefined}
    >
      {pct == null ? "—" : `${Math.round(pct)}%`}
    </span>
  );
}
