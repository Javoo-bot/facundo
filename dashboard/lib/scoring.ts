import type { Florist, ScoreBreakdownResult, Weights, SelectionParams } from "./types";

// Defaults per the brief. Kept here (rather than scattered across components)
// so SliderPanel's "Reset to defaults" has one source of truth.
export const DEFAULT_WEIGHTS: Weights = {
  rating: 1.0,
  reviews: 0.8,
  website: 0.5,
  ecommerce: 1.0,
  distance: 0.3,
  minRating: 4.0,
  minReviews: 20,
};

export const DEFAULT_SELECTION: SelectionParams = {
  topK: 5,
  minSeparationMeters: 500,
};

/**
 * Null-guard correction (see docs/superpowers/specs/2026-07-01-facundo-poc-design.md):
 * `rating`, `review_count`, and `distance_km_from_center` are all nullable columns.
 * The brief's original code does `f.rating - 3.0` with no guard, which produces NaN
 * for any florist missing a rating. Treat null rating/reviews/distance as 0 so a
 * null value can never poison the score with NaN.
 */
export function score(f: Florist, w: Weights): number {
  const rating = f.rating ?? 0;
  const reviewCount = f.review_count ?? 0;
  const distanceKm = f.distance_km_from_center ?? 0;
  return (
    w.rating * (rating - 3.0) +
    w.reviews * Math.log10(reviewCount + 1) +
    w.website * (f.has_website ? 1 : 0) +
    w.ecommerce * (f.is_ecommerce === true ? 1 : 0) -
    w.distance * distanceKm
  );
}

export function passesFilter(f: Florist, w: Weights): boolean {
  return (f.rating ?? 0) >= w.minRating && (f.review_count ?? 0) >= w.minReviews;
}

// For the ScoreBreakdown popup — each term separately so we can display why each
// florist scored what they scored. Same null guards as score().
export function scoreBreakdown(f: Florist, w: Weights): ScoreBreakdownResult {
  const rating = f.rating ?? 0;
  const reviewCount = f.review_count ?? 0;
  const distanceKm = f.distance_km_from_center ?? 0;
  return {
    rating: w.rating * (rating - 3.0),
    reviews: w.reviews * Math.log10(reviewCount + 1),
    website: w.website * (f.has_website ? 1 : 0),
    ecommerce: w.ecommerce * (f.is_ecommerce === true ? 1 : 0),
    distance: -w.distance * distanceKm,
  };
}
