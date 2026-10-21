// Shared color-band classifiers for the Overview page's cell/tile encodings
// (docs/superpowers/specs/2026-07-02-overview-redesign-brief.md "Color
// system"). Pure functions only — components map the returned band name to
// literal Tailwind class strings (dynamic `bg-${band}-50` template strings
// don't survive Tailwind's static content scan).

/** Canonical 4-band rating scale, copied verbatim from components/Map.tsx's
 * `ratingColor()` so the map pins and every rating chip on this page agree
 * on what a given rating means. */
export type RatingBand = "green" | "lime" | "amber" | "red" | "slate";

export function ratingBand(rating: number | null): RatingBand {
  if (rating == null) return "slate";
  if (rating >= 4.5) return "green";
  if (rating >= 4.3) return "lime";
  if (rating >= 4.0) return "amber";
  return "red";
}

/** Coverage (% reachable) bands: good/med/poor/no-data. */
export type CoverageBand = "emerald" | "amber" | "red" | "slate";

export function coverageBand(pct: number | null): CoverageBand {
  if (pct == null) return "slate";
  if (pct >= 70) return "emerald";
  if (pct >= 40) return "amber";
  return "red";
}

/** Ecommerce (% ecommerce) intensity bands — a targeting attribute, not a
 * pass/fail signal, so it gets its own hue (indigo) rather than reusing the
 * rating/coverage hues. */
export type EcommerceBand = "high" | "mid" | "low" | "none";

export function ecommerceBand(pct: number | null): EcommerceBand {
  if (pct == null || pct <= 0) return "none";
  if (pct >= 60) return "high";
  if (pct >= 30) return "mid";
  return "low";
}
