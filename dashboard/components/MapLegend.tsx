// Floating legend card for the map — the map itself is a visual aid only
// (see the sr-only note in MapCard); this legend documents what a sighted
// user is looking at: the 4 rating bands, the dark ring around
// spread-selected pins, and the city-center star. Colors copied verbatim
// from Map.tsx's ratingColor() so the legend never drifts from the pins —
// these are functional data-encoding colors (kept as literal hex, not
// retinted) per the retint brief's "leaflet marker colors" carve-out.
const RATING_BANDS: { label: string; color: string }[] = [
  { label: "≥ 4.5", color: "#22c55e" }, // green-500
  { label: "4.3 – 4.5", color: "#84cc16" }, // lime-500
  { label: "4.0 – 4.3", color: "#f59e0b" }, // amber-500
  { label: "< 4.0", color: "#ef4444" }, // red-500
];

export default function MapLegend() {
  return (
    <div className="absolute bottom-3 left-3 z-[1000] space-y-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[11px] text-ink-soft shadow-md backdrop-blur-sm">
      {RATING_BANDS.map((band) => (
        <div key={band.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: band.color }}
          />
          <span>{band.label} rating</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        {/* Ring/fill colors mirror the actual spread-selected marker style in
         * Map.tsx's buildCircleIcon({ ring: true }) — kept as literal colors
         * (not tokens) so the legend never drifts from the map. */}
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 rounded-full border-2 border-slate-700 bg-slate-300"
        />
        <span>Spread-selected</span>
      </div>
      <div className="flex items-center gap-1.5">
        {/* Matches buildStarIcon()'s fill in Map.tsx — functional marker color. */}
        <span aria-hidden="true" className="text-sm leading-none text-violet-600">
          &#9733;
        </span>
        <span>City center</span>
      </div>
    </div>
  );
}
