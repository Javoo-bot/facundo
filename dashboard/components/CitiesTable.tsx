"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useRef, useState } from "react";
import CityCard from "@/components/CityCard";
import CoverageMeter from "@/components/CoverageMeter";
import CountPill from "@/components/CountPill";
import EcommercePill from "@/components/EcommercePill";
import RatingChip from "@/components/RatingChip";
import RerunConfirmDialog from "@/components/RerunConfirmDialog";
import SimpleToast from "@/components/SimpleToast";
import { IconChevronRight } from "@/components/icons";
import { useToasts } from "@/lib/useToasts";
import { OTHER_REGION, type CityStats, type CountryGroup } from "@/lib/stats";
import type { City } from "@/lib/types";

// Mirrors RerunCityButton's rerun defaults — the row-triggered re-run has no
// limit control either, so it reuses the same fallbacks.
const RERUN_LIMIT = 40;
const FALLBACK_RADIUS_KM = 10;

interface KeywordsCacheEntry {
  keywords: string[];
  language: string;
}

function extractErrorMessage(text: string, status: number): string {
  try {
    return (JSON.parse(text) as { error?: string }).error || text || `Request failed (${status}).`;
  } catch {
    return text || `Request failed (${status}).`;
  }
}

// Collapsed-group key format: a country group's key is just the country
// name; a region group's key is `${country}|${region}` (regions aren't
// unique across countries, e.g. two countries could both have an "Other"
// bucket).
function regionKey(country: string, region: string): string {
  return `${country}|${region}`;
}

type SortColumn =
  | "city"
  | "floristCount"
  | "avgRating"
  | "topTargets"
  | "pctEcommerce"
  | "pctReachable"
  | "emailsFound"
  | "draftsReady";
type SortDirection = "asc" | "desc";
interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

type CityWithStats = City & { stats: CityStats };

const SORTABLE_LEAF_COLUMNS: { id: SortColumn; label: string; minWidth: string }[] = [
  { id: "floristCount", label: "Florists", minWidth: "min-w-[80px]" },
  { id: "avgRating", label: "Avg rating", minWidth: "min-w-[110px]" },
  { id: "topTargets", label: "Top targets", minWidth: "min-w-[100px]" },
  { id: "pctEcommerce", label: "% Ecommerce", minWidth: "min-w-[100px]" },
  { id: "pctReachable", label: "% Reachable", minWidth: "min-w-[140px]" },
  { id: "emailsFound", label: "Emails found", minWidth: "min-w-[100px]" },
  { id: "draftsReady", label: "Drafts ready", minWidth: "min-w-[100px]" },
];

const PLACEHOLDER_TITLE = "Not tracked yet — coming with CRM integration";

function reachableCountFor(stats: CityStats): number | undefined {
  return stats.pctReachable != null
    ? Math.round((stats.pctReachable / 100) * stats.floristCount)
    : undefined;
}

function sortValue(city: CityWithStats, column: SortColumn): string | number | null {
  switch (column) {
    case "city":
      return city.city.toLowerCase();
    case "floristCount":
      return city.stats.floristCount;
    case "avgRating":
      return city.stats.avgRating;
    case "topTargets":
      return city.stats.topTargets;
    case "pctEcommerce":
      return city.stats.pctEcommerce;
    case "pctReachable":
      return city.stats.pctReachable;
    case "emailsFound":
      return city.stats.emailsFound;
    case "draftsReady":
      return city.stats.draftsReady;
  }
}

// Nulls always sort last, regardless of direction — a city with "no data
// yet" shouldn't jump to the top just because the user sorted descending.
function compareCities(a: CityWithStats, b: CityWithStats, sort: SortState): number {
  const av = sortValue(a, sort.column);
  const bv = sortValue(b, sort.column);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  const cmp =
    typeof av === "string" || typeof bv === "string"
      ? String(av).localeCompare(String(bv))
      : (av as number) - (bv as number);
  return sort.direction === "asc" ? cmp : -cmp;
}

function SortCaret({ active, direction }: { active: boolean; direction: SortDirection }) {
  return (
    <span
      aria-hidden="true"
      className={`text-[9px] leading-none ${
        active ? "text-accent" : "text-ink-faint opacity-0 group-hover:opacity-100"
      }`}
    >
      {direction === "desc" ? "▼" : "▲"}
    </span>
  );
}

function SortableTh({
  column,
  label,
  minWidth,
  sort,
  onSort,
}: {
  column: SortColumn;
  label: string;
  minWidth?: string;
  sort: SortState | null;
  onSort: (column: SortColumn) => void;
}) {
  const active = sort?.column === column;
  const direction: SortDirection = active && sort ? sort.direction : "asc";
  const ariaSort = active ? (direction === "asc" ? "ascending" : "descending") : "none";
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`group bg-surface-2 px-3 py-2 text-left align-middle text-xs font-semibold uppercase tracking-wide text-ink-soft ${
        minWidth ?? ""
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 hover:text-ink"
      >
        {label}
        <SortCaret active={active} direction={direction} />
      </button>
    </th>
  );
}

function PlaceholderTh({ label }: { label: string }) {
  return (
    <th
      scope="col"
      className="hidden bg-surface-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-faint lg:table-cell"
    >
      {label}
    </th>
  );
}

function PlaceholderTd() {
  return (
    <td className="hidden px-3 py-2.5 lg:table-cell">
      <span
        className="inline-flex items-center justify-center rounded border border-dashed border-line px-2 py-0.5 text-xs text-ink-faint"
        title={PLACEHOLDER_TITLE}
      >
        —
      </span>
    </td>
  );
}

function RollupCells({ stats }: { stats: CityStats }) {
  return (
    <>
      <td className="px-3 py-2 tabular-nums">{stats.floristCount}</td>
      <td className="px-3 py-2">
        <RatingChip rating={stats.avgRating} reviews={stats.totalReviews} />
      </td>
      <td className="px-3 py-2">
        <CountPill value={stats.topTargets} hue="green" />
      </td>
      <td className="px-3 py-2">
        <EcommercePill pct={stats.pctEcommerce} />
      </td>
      <td className="px-3 py-2">
        <CoverageMeter pct={stats.pctReachable} reachable={reachableCountFor(stats)} total={stats.floristCount} />
      </td>
      <td className="px-3 py-2 tabular-nums">{stats.emailsFound}</td>
      <td className="px-3 py-2">
        <CountPill value={stats.draftsReady} hue="emerald" />
      </td>
      <PlaceholderTd />
      <PlaceholderTd />
      <PlaceholderTd />
    </>
  );
}

function GroupToggle({
  isCollapsed,
  label,
  onToggle,
  size = "h-3.5 w-3.5",
}: {
  isCollapsed: boolean;
  label: string;
  onToggle: () => void;
  size?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!isCollapsed}
      aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
      className="mr-1.5 inline-flex shrink-0 items-center rounded p-0.5 align-middle text-current hover:bg-black/10"
    >
      <IconChevronRight className={`${size} transition-transform ${!isCollapsed ? "rotate-90" : ""}`} />
    </button>
  );
}

function CountryRow({
  country,
  stats,
  isCollapsed,
  onToggle,
}: {
  country: string;
  stats: CityStats;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="border-l-4 border-l-accent bg-surface-2 font-semibold text-ink">
      <th scope="rowgroup" className="py-2 pl-4 pr-3 text-left">
        <GroupToggle isCollapsed={isCollapsed} label={country} onToggle={onToggle} />
        {country}
      </th>
      <RollupCells stats={stats} />
    </tr>
  );
}

function RegionRow({
  region,
  stats,
  isCollapsed,
  onToggle,
}: {
  region: string;
  stats: CityStats;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const isOther = region === OTHER_REGION;
  const label = isOther ? "Other" : region;
  return (
    <tr className="border-l-4 border-l-line-strong bg-surface-2 font-medium text-ink-soft">
      <th
        scope="rowgroup"
        className={`py-2 pl-10 pr-3 text-left font-medium ${isOther ? "italic text-ink-soft" : "text-ink-soft"}`}
      >
        <GroupToggle isCollapsed={isCollapsed} label={label} onToggle={onToggle} size="h-3 w-3" />
        {label}
      </th>
      <RollupCells stats={stats} />
    </tr>
  );
}

function CityRow({ city, isRerunning }: { city: CityWithStats; isRerunning: boolean }) {
  const router = useRouter();
  const { stats } = city;
  return (
    <tr
      onClick={() => router.push(`/city/${city.id}`)}
      className={`cursor-pointer border-b border-line bg-surface transition-colors hover:bg-surface-2 ${
        isRerunning ? "bg-surface-2" : ""
      }`}
    >
      <td className="py-3 pl-20 pr-3">
        <Link
          href={`/city/${city.id}`}
          onClick={(e) => e.stopPropagation()}
          className="font-medium text-ink hover:text-accent-ink"
        >
          {city.city}
        </Link>
        <p className="text-[11px] text-ink-faint">
          {city.radius_km != null ? `${city.radius_km} km radius` : "radius —"}
        </p>
      </td>
      <td className="px-3 py-3 text-sm tabular-nums text-ink-soft">{stats.floristCount}</td>
      <td className="px-3 py-3">
        <RatingChip rating={stats.avgRating} reviews={stats.totalReviews} />
      </td>
      <td className="px-3 py-3">
        <CountPill value={stats.topTargets} hue="green" />
      </td>
      <td className="px-3 py-3">
        <EcommercePill pct={stats.pctEcommerce} />
      </td>
      <td className="px-3 py-3">
        <CoverageMeter pct={stats.pctReachable} reachable={reachableCountFor(stats)} total={stats.floristCount} />
      </td>
      <td className="px-3 py-3 text-sm tabular-nums text-ink-soft">{stats.emailsFound}</td>
      <td className="px-3 py-3">
        <CountPill value={stats.draftsReady} hue="emerald" />
      </td>
      <PlaceholderTd />
      <PlaceholderTd />
      <PlaceholderTd />
    </tr>
  );
}

function MobileRollupSummary({ stats }: { stats: CityStats }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
      <span className="tabular-nums">{stats.floristCount} florists</span>
      <RatingChip rating={stats.avgRating} />
      <CountPill value={stats.topTargets} hue="green" />
      <EcommercePill pct={stats.pctEcommerce} />
      <CoverageMeter pct={stats.pctReachable} reachable={reachableCountFor(stats)} total={stats.floristCount} />
    </div>
  );
}

/**
 * The Overview page's centerpiece: a grouped (country -> region -> city)
 * stats table with sortable columns, plus a card-layout fallback for
 * <768px. Owns sort state and row-triggered re-runs — each re-run is now a
 * fire-and-forget POST /api/ingest (see
 * docs/superpowers/specs/2026-07-02-background-jobs-design.md), so multiple
 * different cities can be "posting" at once; a brief toast confirms the
 * request started and the jobs panel owns progress/completion from there.
 */
export default function CitiesTable({
  groups,
  onRerunSuccess,
}: {
  groups: CountryGroup[];
  onRerunSuccess: () => void;
}) {
  const [sort, setSort] = useState<SortState | null>(null);
  // City ids with an in-flight "start a re-run" request (keyword fetch +
  // POST /api/ingest) — a Set rather than a single id because the duplicate
  // guard now lives server-side per (country, city), so nothing here needs
  // to serialize re-runs of *different* cities.
  const [postingIds, setPostingIds] = useState<Set<string>>(new Set());
  const keywordsCacheRef = useRef<Map<string, KeywordsCacheEntry>>(new Map());
  const { toasts, push, dismiss } = useToasts();
  // Collapsed group keys — country groups key on the country name, region
  // groups key on `${country}|${region}` (see regionKey above). Shared
  // between the desktop table and the mobile card fallback so collapse state
  // survives a resize. Default: countries expanded, regions collapsed — so
  // the initial view is a scannable country-level rollup that drills down on
  // demand (initializer runs once; regions added by a later refresh start
  // expanded, which is fine for the POC).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const countryGroup of groups) {
      for (const regionGroup of countryGroup.regions) {
        initial.add(regionKey(countryGroup.country, regionGroup.region));
      }
    }
    return initial;
  });
  // City pending re-run confirmation (delete-existing-first checkbox) — set
  // by the mobile CityCard re-run button, which opens this confirm dialog
  // instead of posting immediately. The desktop table no longer has a
  // per-row re-run control (its whole row is now a link to the city detail
  // page, where RerunCityButton lives); re-run stays reachable there.
  const [rerunCity, setRerunCity] = useState<City | null>(null);

  // Look up a city's current florist count by id, for the confirm dialog's
  // copy — walked from `groups` rather than trusted off the `City` passed
  // into openRerunConfirm, since CityCard's call site only has a plain City
  // (no `.stats` merged in).
  const floristCountById = useMemo(() => {
    const map = new Map<string, number>();
    for (const countryGroup of groups) {
      for (const regionGroup of countryGroup.regions) {
        for (const city of regionGroup.cities) {
          map.set(city.id, city.stats.floristCount);
        }
      }
    }
    return map;
  }, [groups]);

  const handleSort = (column: SortColumn) => {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, direction: "asc" };
      if (prev.direction === "asc") return { column, direction: "desc" };
      return null;
    });
  };

  const doRerun = async (city: City, resetExisting: boolean) => {
    if (postingIds.has(city.id)) return;
    setPostingIds((prev) => new Set(prev).add(city.id));

    try {
      let kwData = keywordsCacheRef.current.get(city.country);
      if (!kwData) {
        const res = await fetch("/api/keywords", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ country: city.country }),
        });
        if (!res.ok) {
          push("error", extractErrorMessage(await res.text().catch(() => ""), res.status));
          return;
        }
        kwData = (await res.json()) as KeywordsCacheEntry;
        keywordsCacheRef.current.set(city.country, kwData);
      }

      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: city.country,
          city: city.city,
          radius: city.radius_km ?? FALLBACK_RADIUS_KM,
          limit: RERUN_LIMIT,
          keywords: kwData.keywords,
          language: kwData.language,
          resetExisting,
        }),
      });

      if (!res.ok) {
        push("error", extractErrorMessage(await res.text().catch(() => ""), res.status));
        return;
      }

      push("success", `Re-running ${city.city}, ${city.country}… track progress in the jobs panel.`);
      onRerunSuccess();
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Re-run failed to start.");
    } finally {
      setPostingIds((prev) => {
        const next = new Set(prev);
        next.delete(city.id);
        return next;
      });
    }
  };

  const openRerunConfirm = (city: City) => {
    if (postingIds.has(city.id)) return;
    setRerunCity(city);
  };

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface shadow-sm md:block">
        <table className="w-full min-w-[960px] border-collapse text-sm">
          <caption className="sr-only">
            Cities grouped by country and region, with market, targeting, outreach-readiness, and
            outreach-performance stats for each.
          </caption>
          <thead className="sticky top-0 z-20 bg-surface-2">
            <tr className="border-b border-line text-center text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              <th
                rowSpan={2}
                scope="col"
                className="min-w-[180px] bg-surface-2 px-3 py-2 text-left align-middle text-xs normal-case tracking-wide text-ink-soft"
              >
                City
              </th>
              <th colSpan={3} scope="colgroup" className="border-l border-line px-3 py-1">
                Market
              </th>
              <th colSpan={2} scope="colgroup" className="border-l border-line px-3 py-1">
                Targeting
              </th>
              <th colSpan={2} scope="colgroup" className="border-l border-line px-3 py-1">
                Outreach readiness
              </th>
              <th
                colSpan={3}
                scope="colgroup"
                className="hidden border-l border-line px-3 py-1 lg:table-cell"
              >
                Outreach performance
                <span className="ml-1.5 inline-flex items-center rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] font-semibold text-ink-soft" style={{ boxShadow: "inset 0 0 0 1px var(--line-strong)" }}>
                  SOON
                </span>
              </th>
            </tr>
            <tr className="border-b border-line">
              {SORTABLE_LEAF_COLUMNS.map((col) => (
                <SortableTh
                  key={col.id}
                  column={col.id}
                  label={col.label}
                  minWidth={col.minWidth}
                  sort={sort}
                  onSort={handleSort}
                />
              ))}
              <PlaceholderTh label="Sent" />
              <PlaceholderTh label="Replies" />
              <PlaceholderTh label="Reply rate" />
            </tr>
          </thead>
          <tbody>
            {groups.map((countryGroup) => {
              const countryCollapsed = collapsed.has(countryGroup.country);
              return (
                <Fragment key={countryGroup.country}>
                  <CountryRow
                    country={countryGroup.country}
                    stats={countryGroup.stats}
                    isCollapsed={countryCollapsed}
                    onToggle={() => toggleCollapsed(countryGroup.country)}
                  />
                  {!countryCollapsed &&
                    countryGroup.regions.map((regionGroup) => {
                      const key = regionKey(countryGroup.country, regionGroup.region);
                      const regionCollapsed = collapsed.has(key);
                      const sortedCities = sort
                        ? [...regionGroup.cities].sort((a, b) => compareCities(a, b, sort))
                        : regionGroup.cities;
                      return (
                        <Fragment key={regionGroup.region}>
                          <RegionRow
                            region={regionGroup.region}
                            stats={regionGroup.stats}
                            isCollapsed={regionCollapsed}
                            onToggle={() => toggleCollapsed(key)}
                          />
                          {!regionCollapsed &&
                            sortedCities.map((city) => (
                              <CityRow key={city.id} city={city} isRerunning={postingIds.has(city.id)} />
                            ))}
                        </Fragment>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-6 md:hidden">
        {groups.map((countryGroup) => {
          const countryCollapsed = collapsed.has(countryGroup.country);
          return (
            <div key={countryGroup.country}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
                <button
                  type="button"
                  onClick={() => toggleCollapsed(countryGroup.country)}
                  aria-expanded={!countryCollapsed}
                  aria-label={`${countryCollapsed ? "Expand" : "Collapse"} ${countryGroup.country}`}
                  className="flex items-center gap-1 text-base font-semibold text-ink"
                >
                  <IconChevronRight
                    className={`h-4 w-4 text-ink-faint transition-transform ${!countryCollapsed ? "rotate-90" : ""}`}
                  />
                  {countryGroup.country}
                </button>
                <MobileRollupSummary stats={countryGroup.stats} />
              </div>

              {!countryCollapsed && (
                <div className="mt-4 space-y-5">
                  {countryGroup.regions.map((regionGroup) => (
                    <div key={regionGroup.region}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h4
                          className={`text-sm font-medium ${
                            regionGroup.region === OTHER_REGION ? "italic text-ink-soft" : "text-ink-soft"
                          }`}
                        >
                          {regionGroup.region === OTHER_REGION ? "Other" : regionGroup.region}
                        </h4>
                        <MobileRollupSummary stats={regionGroup.stats} />
                      </div>

                      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {regionGroup.cities.map((city) => (
                          <CityCard
                            key={city.id}
                            city={city}
                            stats={city.stats}
                            isRerunning={postingIds.has(city.id)}
                            rerunDisabled={postingIds.has(city.id)}
                            onRerun={openRerunConfirm}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {rerunCity && (
        <RerunConfirmDialog
          city={rerunCity}
          floristCount={floristCountById.get(rerunCity.id) ?? null}
          onConfirm={(resetExisting) => {
            const city = rerunCity;
            setRerunCity(null);
            doRerun(city, resetExisting);
          }}
          onCancel={() => setRerunCity(null)}
        />
      )}

      <SimpleToast toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
