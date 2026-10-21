// Per-florist boolean indicator (website / ecommerce columns in FloristTable
// and the map popup) — deliberately NOT the city-level EcommercePill (that's
// an intensity pill over a %, this is a single florist's yes/no/unknown).
// Current-code defect #4 (docs/superpowers/specs/
// 2026-07-02-city-page-redesign-brief.md): the old emerald-check/red-cross
// treatment implied pass/fail. Fixed here: `true` gets the same bloom hue
// EcommercePill uses (a targeting-attribute color, not a "good" color),
// `false`/`null` both get a neutral treatment (absence isn't a failure) —
// `null` gets a "?" glyph so an unknown value is never visually
// indistinguishable from a confirmed "no".
export default function BoolBadge({ label, value }: { label: string; value: boolean | null }) {
  if (value === null) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-faint"
        title={`${label}: unknown`}
      >
        {label} ?
      </span>
    );
  }
  if (value) {
    return (
      <span
        className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium text-bloom"
        style={{
          background: "color-mix(in srgb, var(--tB) 12%, transparent)",
          boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--tB) 20%, transparent)",
        }}
      >
        {label} &#10003;
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-faint"
      title={`${label}: no`}
    >
      {label} &#8212;
    </span>
  );
}
