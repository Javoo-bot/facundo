import CountPill from "@/components/CountPill";
import CoverageMeter from "@/components/CoverageMeter";
import EcommercePill from "@/components/EcommercePill";
import RatingChip from "@/components/RatingChip";
import type { CityStats } from "@/lib/stats";

function reachableCountFor(stats: CityStats): number | undefined {
  return stats.pctReachable != null
    ? Math.round((stats.pctReachable / 100) * stats.floristCount)
    : undefined;
}

/**
 * Compact stats strip reusing the Overview page's cell encodings
 * (RatingChip/CountPill/EcommercePill/CoverageMeter). Deliberately computed
 * from the RAW florist dataset (via lib/stats.computeCityStats), not the
 * live-filtered set, so it stays stable while sliders move — the live
 * filtered count is a separate "Showing X of N" caption + Reset link so the
 * two numbers are never confused with each other.
 */
export default function CityVitalsBar({
  stats,
  shownCount,
  totalCount,
  onReset,
}: {
  stats: CityStats;
  shownCount: number;
  totalCount: number;
  onReset: () => void;
}) {
  const isFiltered = shownCount !== totalCount;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-surface px-4 py-2.5 shadow-sm">
      <span className="text-sm tabular-nums text-ink-soft">
        <span className="font-semibold text-ink">{stats.floristCount}</span> florist
        {stats.floristCount === 1 ? "" : "s"}
      </span>

      <span className="flex items-center gap-1.5 text-xs text-ink-soft">
        Avg rating
        <RatingChip rating={stats.avgRating} />
      </span>

      <span className="flex items-center gap-1.5 text-xs text-ink-soft">
        Top targets
        <CountPill value={stats.topTargets} hue="green" />
      </span>

      <span className="flex items-center gap-1.5 text-xs text-ink-soft">
        Ecommerce
        <EcommercePill pct={stats.pctEcommerce} />
      </span>

      <span className="flex items-center gap-1.5 text-xs text-ink-soft">
        Reachable
        <CoverageMeter
          pct={stats.pctReachable}
          reachable={reachableCountFor(stats)}
          total={stats.floristCount}
        />
      </span>

      <span className="flex items-center gap-1.5 text-xs text-ink-soft">
        Drafts ready
        <CountPill value={stats.draftsReady} hue="emerald" />
      </span>

      <span className="ml-auto flex items-center gap-2 text-xs text-ink-soft">
        Showing <span className="tabular-nums font-medium text-ink-soft">{shownCount}</span> of{" "}
        <span className="tabular-nums font-medium text-ink-soft">{totalCount}</span>
        {isFiltered && (
          <button
            type="button"
            onClick={onReset}
            className="font-medium text-accent underline decoration-dotted underline-offset-2 hover:text-accent-ink"
          >
            Reset
          </button>
        )}
      </span>
    </div>
  );
}
