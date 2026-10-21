import Link from "next/link";
import RatingChip from "@/components/RatingChip";
import CoverageMeter from "@/components/CoverageMeter";
import EcommercePill from "@/components/EcommercePill";
import CountPill from "@/components/CountPill";
import type { CityStats } from "@/lib/stats";
import type { City } from "@/lib/types";

const PLACEHOLDER_TITLE = "Not tracked yet — coming with CRM integration";

/** <768px card layout — same cell encodings as CitiesTable's desktop rows,
 * just stacked instead of columned. */
export default function CityCard({
  city,
  stats,
  isRerunning,
  rerunDisabled,
  onRerun,
}: {
  city: City;
  stats: CityStats;
  isRerunning: boolean;
  rerunDisabled: boolean;
  onRerun: (city: City) => void;
}) {
  const reachable =
    stats.pctReachable != null ? Math.round((stats.pctReachable / 100) * stats.floristCount) : undefined;

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-sm transition-colors ${
        isRerunning ? "bg-surface-2" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <Link href={`/city/${city.id}`} className="font-semibold text-ink hover:text-accent-ink">
            {city.city}
          </Link>
          <p className="text-xs text-ink-faint">
            {city.radius_km != null ? `${city.radius_km} km radius` : "radius —"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => onRerun(city)}
            disabled={rerunDisabled}
            aria-label={`Re-run ingest for ${city.city}, ${city.country}`}
            title="Re-run ingest for this city"
            className="rounded p-1 text-ink-faint transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className={`inline-block ${isRerunning ? "animate-spin" : ""}`} aria-hidden="true">
              ↻
            </span>
          </button>
          <Link
            href={`/city/${city.id}`}
            className="group inline-flex items-center text-sm font-medium text-accent hover:text-accent-ink"
          >
            View
            <span className="ml-0.5 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true">
              →
            </span>
          </Link>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
        <div>
          <dt className="text-xs text-ink-soft">Florists</dt>
          <dd className="tabular-nums text-ink-soft">{stats.floristCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Avg rating</dt>
          <dd>
            <RatingChip rating={stats.avgRating} reviews={stats.totalReviews} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Top targets</dt>
          <dd>
            <CountPill value={stats.topTargets} hue="green" />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">% Ecommerce</dt>
          <dd>
            <EcommercePill pct={stats.pctEcommerce} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">% Reachable</dt>
          <dd>
            <CoverageMeter pct={stats.pctReachable} reachable={reachable} total={stats.floristCount} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Emails found</dt>
          <dd className="tabular-nums text-ink-soft">{stats.emailsFound}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Drafts ready</dt>
          <dd>
            <CountPill value={stats.draftsReady} hue="emerald" />
          </dd>
        </div>
      </dl>

      <div className="flex items-center gap-3 border-t border-line pt-3 text-xs text-ink-faint">
        <span title={PLACEHOLDER_TITLE}>Sent —</span>
        <span title={PLACEHOLDER_TITLE}>Replies —</span>
        <span title={PLACEHOLDER_TITLE}>Reply rate —</span>
      </div>
    </div>
  );
}
