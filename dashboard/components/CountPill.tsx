// Colored pill for outcome/quality counts (top targets, drafts ready) — per
// the brief's governing rule, plain neutral counts stay plain numerals and
// only outcome/quality counts get a colored pill. Both hues resolve to the
// design system's single positive-outcome token (--accent) — the wash
// background is built via color-mix since the token color is a CSS var and
// Tailwind's opacity-modifier syntax (`bg-accent/10`) doesn't compile against it.
const HUE_CLASSES = {
  green: "text-accent",
  emerald: "text-accent",
} as const;

export default function CountPill({
  value,
  hue,
}: {
  value: number;
  hue: keyof typeof HUE_CLASSES;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${HUE_CLASSES[hue]}`}
      style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
    >
      {value}
    </span>
  );
}
