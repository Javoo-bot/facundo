import { ratingBand, type RatingBand } from "@/lib/bands";

// Contrast formula from the brief: {hue}-700 text on {hue}-50 bg, ring-1
// ring-inset ring-{hue}-600/20 — ported to design-system tokens below. Each
// band maps to a CSS var (not a Tailwind color class) because the wash
// background + ring are built with color-mix() — Tailwind's opacity-modifier
// syntax (e.g. `bg-accent/10`) doesn't compile against CSS-var colors. Two
// bands ("green"/"lime", the top two rating tiers) intentionally use
// different tokens (--accent and --ok) even though the botanical palette
// currently defines them as the same color, preserving the 4-tier distinction
// in the source so a future palette split (e.g. a dedicated --ok) doesn't
// require touching this component.
const BAND_VAR: Record<RatingBand, string> = {
  green: "var(--accent)",
  lime: "var(--ok)",
  amber: "var(--tC)",
  red: "var(--crit)",
  slate: "var(--ink-faint)",
};

export default function RatingChip({
  rating,
  reviews,
}: {
  rating: number | null;
  /** Total review count, rendered as subtext under the chip. Omitted (not
   * just 0) when the caller has no review data at all. */
  reviews?: number | null;
}) {
  const band = ratingBand(rating);
  const colorVar = BAND_VAR[band];
  return (
    <div className="inline-flex flex-col items-start gap-0.5">
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
        style={{
          color: colorVar,
          background: `color-mix(in srgb, ${colorVar} 12%, transparent)`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${colorVar} 20%, transparent)`,
        }}
      >
        {rating != null ? `★ ${rating.toFixed(1)}` : "—"}
      </span>
      {reviews != null && (
        <span className="text-[11px] tabular-nums text-ink-faint">
          {reviews} review{reviews === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}
