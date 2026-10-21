import "server-only";

import { createServiceClient } from "@/lib/supabaseAdmin";
import {
  DEFAULT_MATCH_CONFIG,
  MATCH_CONFIG_COLUMNS,
  parseMatchConfig,
  parseRingEdges,
  type MatchConfig,
} from "@/lib/match";

// The staff-tuned matching knobs (Settings → Matching), read for the backoffice
// re-match so it ranks florists exactly as the worker's automatic match does.
// Kept in step with ingest-worker/src/db.ts::loadMatchConfig — both are thin
// reads around the same pure parser in lib/match.ts, which is where the
// per-field fallback behavior actually lives.

/** Load the saved config. Never throws: a failed read yields the compiled
 *  defaults, because matching must not be the thing that breaks when a settings
 *  read does. */
export async function loadMatchConfig(
  admin: ReturnType<typeof createServiceClient>
): Promise<MatchConfig> {
  try {
    const { data } = await admin.from("app_settings").select(MATCH_CONFIG_COLUMNS).eq("id", 1).maybeSingle();
    return parseMatchConfig(data as Record<string, unknown> | null);
  } catch {
    return DEFAULT_MATCH_CONFIG;
  }
}

/**
 * Apply a per-run override from the "Find florists" panel on top of `base`.
 *
 * This is CLIENT input, so every field is validated rather than trusted, and an
 * absent or unusable field leaves the saved value untouched — an override is a
 * patch, not a replacement. Nothing here writes to app_settings: the operator is
 * changing one run, not the system's defaults.
 *
 * `minRating`/`minReviewCount` accept an explicit `null` to mean "no floor",
 * which is why they're checked for presence rather than for truthiness — 0 and
 * null are different answers and both are legal.
 */
export function applyConfigOverride(base: MatchConfig, override: unknown): MatchConfig {
  if (!override || typeof override !== "object") return base;
  const o = override as Record<string, unknown>;
  const w = (o.weights ?? {}) as Record<string, unknown>;

  const numOr = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return v != null && v !== "" && Number.isFinite(n) ? n : fallback;
  };
  const floorOr = (key: string, fallback: number | null): number | null => {
    if (!(key in o)) return fallback;
    if (o[key] == null || o[key] === "") return null; // explicit "no floor"
    const n = Number(o[key]);
    return Number.isFinite(n) ? n : fallback;
  };
  const boolOr = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

  return {
    // parseRingEdges rejects a half-valid ladder wholesale, falling back to the
    // saved edges rather than silently mis-bucketing every candidate.
    ringEdgesKm: parseRingEdges(o.ringEdgesKm, base.ringEdgesKm),
    weights: {
      distance: numOr(w.distance, base.weights.distance),
      onboarded: numOr(w.onboarded, base.weights.onboarded),
      emailable: numOr(w.emailable, base.weights.emailable),
      quality: numOr(w.quality, base.weights.quality),
      source: numOr(w.source, base.weights.source),
      tier: numOr(w.tier, base.weights.tier),
      performance: numOr(w.performance, base.weights.performance),
    },
    // Bounded: a 0 would return nothing and a huge value would write hundreds of
    // assignment rows from one click.
    topN: Math.min(25, Math.max(1, Math.round(numOr(o.topN, base.topN)))),
    minRating: floorOr("minRating", base.minRating),
    minReviewCount: floorOr("minReviewCount", base.minReviewCount),
    allowUnrated: boolOr(o.allowUnrated, base.allowUnrated),
    excludeTier4: boolOr(o.excludeTier4, base.excludeTier4),
    requireTrustTier: boolOr(o.requireTrustTier, base.requireTrustTier),
  };
}
