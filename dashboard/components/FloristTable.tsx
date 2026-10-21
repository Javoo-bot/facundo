"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import BoolBadge from "@/components/BoolBadge";
import RatingChip from "@/components/RatingChip";
import { IconExternalLink } from "@/components/icons";
import { LIFECYCLE_STAGES, STAGE_LABEL } from "@/lib/pipeline";
import type { Florist, LifecycleStage } from "@/lib/types";

export interface ScoredFlorist {
  florist: Florist;
  score: number;
}

type SortColumn = "name" | "rating" | "reviews" | "website" | "ecommerce" | "distance" | "score";
type SortDirection = "asc" | "desc";
interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

// Default sort: Score desc — matches the incoming `rows` order (already
// score-sorted by DashboardClient) so switching this table's own sort state
// on/off doesn't visibly reorder anything on first render.
const DEFAULT_SORT: SortState = { column: "score", direction: "desc" };

function sortValue(row: ScoredFlorist, column: SortColumn): string | number | boolean | null {
  const { florist, score } = row;
  switch (column) {
    case "name":
      return florist.name.toLowerCase();
    case "rating":
      return florist.rating;
    case "reviews":
      return florist.review_count;
    case "website":
      return florist.has_website;
    case "ecommerce":
      return florist.is_ecommerce;
    case "distance":
      return florist.distance_km_from_center;
    case "score":
      return score;
  }
}

// Nulls (missing rating/reviews/distance/ecommerce-unknown) always sort
// last, regardless of direction — mirrors CitiesTable's compareCities so a
// "no data yet" florist doesn't jump to the top on a descending sort.
function compareRows(a: ScoredFlorist, b: ScoredFlorist, sort: SortState): number {
  const av = sortValue(a, sort.column);
  const bv = sortValue(b, sort.column);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  let cmp: number;
  if (typeof av === "boolean" || typeof bv === "boolean") {
    cmp = Number(av) - Number(bv);
  } else if (typeof av === "string" || typeof bv === "string") {
    cmp = String(av).localeCompare(String(bv));
  } else {
    cmp = (av as number) - (bv as number);
  }
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
  align = "left",
  sort,
  onSort,
}: {
  column: SortColumn;
  label: string;
  align?: "left" | "right" | "center";
  sort: SortState;
  onSort: (column: SortColumn) => void;
}) {
  const active = sort.column === column;
  const direction: SortDirection = active ? sort.direction : "asc";
  const ariaSort = active ? (direction === "asc" ? "ascending" : "descending") : "none";
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "";
  const textAlign = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th scope="col" aria-sort={ariaSort} className={`group sticky top-0 bg-surface-2 px-3 py-2 ${textAlign}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-soft hover:text-ink ${justify}`}
      >
        {label}
        <SortCaret active={active} direction={direction} />
      </button>
    </th>
  );
}

function PlainTh({ label, align = "left" }: { label: string; align?: "left" | "right" | "center" }) {
  const textAlign = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th
      scope="col"
      className={`sticky top-0 bg-surface-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-soft ${textAlign}`}
    >
      {label}
    </th>
  );
}

function StageChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 font-medium transition ${
        active
          ? "border-accent text-accent bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
          : "border-line text-ink-soft hover:border-line-strong hover:bg-surface-2"
      }`}
    >
      {label} <span className="tabular-nums opacity-60">{count}</span>
    </button>
  );
}

export default function FloristTable({
  rows,
  spreadIds,
  hoveredId,
  selectedId,
  totalCount,
  onHoverFlorist,
  onSelectFlorist,
  onReset,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  sentCountById,
  onMarkTarget,
}: {
  rows: ScoredFlorist[];
  spreadIds: Set<string>;
  hoveredId: string | null;
  /** The florist whose detail panel is currently open — drives a distinct
   * "selected" row style separate from hover, matching Map.tsx's
   * hover/selection decoupling. */
  selectedId: string | null;
  /** Count of florists ingested for this city before any filter — needed to
   * tell "0 rows because zero florists" apart from "0 rows because filters
   * excluded everyone" (the latter gets a Reset button). */
  totalCount: number;
  onHoverFlorist: (id: string | null) => void;
  onSelectFlorist: (florist: Florist) => void;
  onReset: () => void;
  /** Outreach multi-select state — a florist is selectable only when it has
   * an email (nothing to send to otherwise). */
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: (ids: string[]) => void;
  /** Count of successfully-sent emails per florist — renders the "✉ N"
   * sent-count badge next to the name (hidden when 0). */
  sentCountById: Map<string, number>;
  /** Advance a florist to `targeted` (Discovery shortlist). Optional — when
   * omitted, the per-row target action is hidden. */
  onMarkTarget?: (id: string) => void;
}) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  // Stage filter — "all" shows everything; a specific stage narrows the table
  // to just those florists (e.g. "Contacted" = the ones you've reached out to).
  const [stageFilter, setStageFilter] = useState<LifecycleStage | "all">("all");

  // Rank reflects the incoming (score-sorted) order regardless of how the
  // table is currently sorted for display — so "#3 by score" stays visible
  // even while the analyst is browsing alphabetically.
  const rankById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => map.set(row.florist.id, i + 1));
    return map;
  }, [rows]);

  const sortedRows = useMemo(() => [...rows].sort((a, b) => compareRows(a, b, sort)), [rows, sort]);

  // Per-stage counts for the filter bar (from the full row set, not the
  // currently-filtered view) so each chip shows its true total.
  const stageCounts = useMemo(() => {
    const m = new Map<LifecycleStage, number>();
    for (const r of rows) {
      const s = r.florist.lifecycle_stage;
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  const visibleRows = useMemo(
    () =>
      stageFilter === "all"
        ? sortedRows
        : sortedRows.filter((r) => r.florist.lifecycle_stage === stageFilter),
    [sortedRows, stageFilter]
  );

  // Only florists with an email are "sendable" — there's nothing to send an
  // outreach email to otherwise. Select-all only ever touches this subset.
  const sendableIds = useMemo(
    () => rows.filter((r) => r.florist.email).map((r) => r.florist.id),
    [rows]
  );
  const allSendableSelected =
    sendableIds.length > 0 && sendableIds.every((id) => selectedIds.has(id));

  const handleSort = (column: SortColumn) => {
    setSort((prev) => {
      if (prev.column !== column) return { column, direction: "asc" };
      return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
    });
  };

  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, florist: Florist) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelectFlorist(florist);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Stage filter bar — click a stage to narrow the table to just those
       * florists (e.g. "Contacted" = the ones you've reached out to). */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface px-3 py-2 text-xs">
        <span className="mr-1 uppercase tracking-wide text-ink-faint">Stage</span>
        <StageChip
          label="All"
          count={rows.length}
          active={stageFilter === "all"}
          onClick={() => setStageFilter("all")}
        />
        {LIFECYCLE_STAGES.filter((s) => (stageCounts.get(s) ?? 0) > 0).map((s) => (
          <StageChip
            key={s}
            label={STAGE_LABEL[s]}
            count={stageCounts.get(s) ?? 0}
            active={stageFilter === s}
            onClick={() => setStageFilter(s)}
          />
        ))}
      </div>
      <div className="flex-1 overflow-auto">
      <table className="w-full min-w-[960px] border-collapse text-sm">
        <caption className="sr-only">
          Florists in this city, sortable by column. This table is the accessible source of
          truth for the map above — every plotted pin also appears here as a row.
        </caption>
        <thead className="text-left text-xs uppercase tracking-wide text-ink-soft">
          <tr>
            <th scope="col" className="sticky top-0 bg-surface-2 px-3 py-2">
              <input
                type="checkbox"
                checked={allSendableSelected}
                disabled={sendableIds.length === 0}
                onChange={() => onToggleSelectAll(sendableIds)}
                aria-label="Select all sendable florists"
                title="Select all florists with an email"
              />
            </th>
            <PlainTh label="#" align="right" />
            <SortableTh column="name" label="Name" sort={sort} onSort={handleSort} />
            <SortableTh column="rating" label="Rating" align="right" sort={sort} onSort={handleSort} />
            <SortableTh column="reviews" label="Reviews" align="right" sort={sort} onSort={handleSort} />
            <SortableTh column="website" label="Website" align="center" sort={sort} onSort={handleSort} />
            <SortableTh column="ecommerce" label="Ecommerce" align="center" sort={sort} onSort={handleSort} />
            <SortableTh column="distance" label="Distance (km)" align="right" sort={sort} onSort={handleSort} />
            <PlainTh label="Email" />
            <PlainTh label="Phone" />
            <SortableTh column="score" label="Score" align="right" sort={sort} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {visibleRows.length === 0 &&
            (totalCount === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-ink-faint">
                  No florists ingested for this city yet.
                </td>
              </tr>
            ) : stageFilter !== "all" ? (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-ink-faint">
                  No florists in <span className="font-medium">{STAGE_LABEL[stageFilter]}</span>.{" "}
                  <button
                    type="button"
                    onClick={() => setStageFilter("all")}
                    className="font-medium text-accent underline decoration-dotted underline-offset-2 hover:text-accent-ink"
                  >
                    Show all
                  </button>
                </td>
              </tr>
            ) : (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-ink-faint">
                  <span className="tabular-nums">0 of {totalCount}</span> florists match your
                  filters.{" "}
                  <button
                    type="button"
                    onClick={onReset}
                    className="font-medium text-accent underline decoration-dotted underline-offset-2 hover:text-accent-ink"
                  >
                    Reset
                  </button>
                </td>
              </tr>
            ))}
          {visibleRows.map(({ florist, score }) => {
            const isSpread = spreadIds.has(florist.id);
            const isHovered = hoveredId === florist.id;
            const isSelected = selectedId === florist.id;
            const phone = florist.phone_web ?? florist.phone_maps;
            return (
              <tr
                key={florist.id}
                tabIndex={0}
                onMouseEnter={() => onHoverFlorist(florist.id)}
                onMouseLeave={() => onHoverFlorist(null)}
                onClick={() => onSelectFlorist(florist)}
                onKeyDown={(e) => handleRowKeyDown(e, florist)}
                // `outline` (not `ring`/box-shadow) for the focus indicator —
                // box-shadow-based rings are unreliable on table rows in
                // several browser engines (a known CSS-tables painting
                // quirk); an inset outline always renders correctly.
                className={`cursor-pointer border-b border-line outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)] ${
                  isSelected
                    ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]"
                    : isSpread
                      ? "bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                      : ""
                } ${isHovered ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]" : ""} hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]`}
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(florist.id)}
                    disabled={!florist.email}
                    onChange={() => onToggleSelect(florist.id)}
                    title={florist.email ? undefined : "No email to send to"}
                    aria-label={`Select ${florist.name} for outreach`}
                  />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-faint">
                  {rankById.get(florist.id)}
                </td>
                <td className="px-3 py-2 font-medium text-ink">
                  <span className="inline-flex items-center gap-1.5">
                    <Link
                      href={`/florists/${florist.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-ink hover:text-accent-ink hover:underline"
                    >
                      {florist.name}
                    </Link>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-soft">
                      {STAGE_LABEL[florist.lifecycle_stage]}
                    </span>
                    {(sentCountById.get(florist.id) ?? 0) > 0 && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-accent" style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
                        title={`${sentCountById.get(florist.id)} outreach email(s) sent`}
                      >
                        ✉ {sentCountById.get(florist.id)}
                      </span>
                    )}
                    {florist.website_url && (
                      <a
                        href={florist.website_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Open ${florist.name}'s website in a new tab`}
                        title="Open website"
                        className="text-ink-faint hover:text-accent"
                      >
                        <IconExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {onMarkTarget && florist.lifecycle_stage === "found" && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMarkTarget(florist.id);
                        }}
                        className="rounded border border-line-strong px-1.5 py-0.5 text-[10px] font-medium text-ink-soft hover:bg-surface-2"
                      >
                        Mark target
                      </button>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <RatingChip rating={florist.rating} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-soft">
                  {florist.review_count ?? "—"}
                </td>
                <td className="px-3 py-2 text-center">
                  <BoolBadge label="Website" value={florist.has_website} />
                </td>
                <td className="px-3 py-2 text-center">
                  <BoolBadge label="Ecommerce" value={florist.is_ecommerce} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {florist.distance_km_from_center != null
                    ? florist.distance_km_from_center.toFixed(2)
                    : "—"}
                </td>
                <td className="px-3 py-2 text-ink-soft">
                  {florist.email ? (
                    <span className="inline-flex items-center gap-1">
                      <a
                        href={`mailto:${florist.email}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-accent hover:underline"
                      >
                        {florist.email}
                      </a>
                      {florist.drafted_email && (
                        <span
                          className="text-accent"
                          title="Draft email ready"
                          aria-label="Draft email ready"
                        >
                          &#9993;
                        </span>
                      )}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-ink-soft">
                  {phone ? (
                    <a
                      href={`tel:${phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-accent hover:underline"
                    >
                      {phone}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{score.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
