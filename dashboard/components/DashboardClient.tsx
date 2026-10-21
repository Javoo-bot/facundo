"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import CityVitalsBar from "@/components/CityVitalsBar";
import ControlsRail from "@/components/ControlsRail";
import EmptyState from "@/components/EmptyState";
import FloristTable, { type ScoredFlorist } from "@/components/FloristTable";
import HowDataCollectedModal from "@/components/HowDataCollectedModal";
import OutreachSendPanel from "@/components/OutreachSendPanel";
import RerunCityButton from "@/components/RerunCityButton";
import RepairButton from "@/components/RepairButton";
import ScoreBreakdown from "@/components/ScoreBreakdown";
import { IconMapPin } from "@/components/icons";
import { LIFECYCLE_STAGES, STAGE_LABEL } from "@/lib/pipeline";
import { DEFAULT_SELECTION, DEFAULT_WEIGHTS, passesFilter, score } from "@/lib/scoring";
import { selectSpread } from "@/lib/spread";
import { computeCityStats } from "@/lib/stats";
import type {
  AppSettings,
  City,
  Florist,
  LifecycleStage,
  Outreach,
  SelectionParams,
  Weights,
} from "@/lib/types";

// Leaflet touches `window`/`document` at import time — dynamic import with
// ssr:false at the usage site keeps it out of the server render entirely.
const Map = dynamic(() => import("@/components/Map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-ink-faint">
      Loading map…
    </div>
  ),
});

// Fixed `en-US`/`timeZone: "UTC"` (not the ambient locale/timezone) so this
// renders identically during the server-side pass and after client
// hydration — a locale- or TZ-dependent format here would be a classic
// hydration-mismatch source.
function formatIngestedAt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

const RERUN_BUTTON_CLASSNAME =
  "inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft shadow-sm transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40";

export default function DashboardClient({
  initialFlorists,
  city,
  settings,
  outreach,
}: {
  initialFlorists: Florist[];
  city: City;
  settings: AppSettings | null;
  outreach: Outreach[];
}) {
  const router = useRouter();
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [selection, setSelection] = useState<SelectionParams>(DEFAULT_SELECTION);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedFlorist, setSelectedFlorist] = useState<Florist | null>(null);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  // Target stage for the bulk "Move" action on the current multi-selection.
  // Defaults to Engaged — the common move once florists have replied.
  const [bulkStage, setBulkStage] = useState<LifecycleStage>("engaged");
  const [bulkBusy, setBulkBusy] = useState(false);

  // Count of successfully-sent emails per florist — drives the "✉ N" sent-count
  // badge in FloristTable. Derived from the outreach log rather than a column on
  // `florists` so it stays in sync with the CRM history shown in the detail
  // drawer / florist card without a second round-trip.
  const sentCountById = useMemo(() => {
    // globalThis.Map — the bare `Map` name is the imported Leaflet map component here.
    const m = new globalThis.Map<string, number>();
    for (const o of outreach) {
      if (o.status === "sent") m.set(o.florist_id, (m.get(o.florist_id) ?? 0) + 1);
    }
    return m;
  }, [outreach]);

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSelectAll = (ids: string[]) =>
    setSelectedIds((prev) => (ids.every((i) => prev.has(i)) ? new Set() : new Set(ids)));

  // Everything below is pure client-side math — no server round-trip on any
  // slider move. filtered -> scored -> sorted -> spread-selected, recomputed
  // synchronously via useMemo so the map and table re-render within a frame.
  // Florists are already scoped to this city by the server query; passesFilter
  // still applies the weight-based rating/review-count threshold.
  const filtered = useMemo(
    () => initialFlorists.filter((f) => passesFilter(f, weights)),
    [initialFlorists, weights]
  );

  const scoredSorted = useMemo<ScoredFlorist[]>(
    () =>
      filtered
        .map((florist) => ({ florist, score: score(florist, weights) }))
        .sort((a, b) => b.score - a.score),
    [filtered, weights]
  );

  const spreadIds = useMemo(() => {
    const ranked = scoredSorted.map((s) => s.florist);
    const spread = selectSpread(ranked, selection.topK, selection.minSeparationMeters);
    return new Set(spread.map((f) => f.id));
  }, [scoredSorted, selection]);

  // Vitals strip stats come from the RAW dataset, not `filtered` — see
  // CityVitalsBar's doc comment for why (stability while sliders move).
  const vitalsStats = useMemo(() => computeCityStats(initialFlorists), [initialFlorists]);

  // Ambient target for SliderPanel's weight-contribution bars: the open
  // detail panel's florist if there is one, else rank #1 of the current
  // sort ("Decisions taken" in the brief — this is informational, not a CTA).
  const targetFlorist = selectedFlorist ?? scoredSorted[0]?.florist ?? null;

  const handleReset = () => {
    setWeights(DEFAULT_WEIGHTS);
    setSelection(DEFAULT_SELECTION);
  };

  const handleRerunSuccess = () => router.refresh();

  const handleMarkTarget = async (id: string) => {
    try {
      const res = await fetch("/api/florists/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floristId: id, stage: "targeted" }),
      });
      if (res.ok) router.refresh();
    } catch {
      /* non-fatal: the badge just won't advance; user can retry */
    }
  };

  // Bulk-move every selected florist to `bulkStage` (one call each — there's no
  // batch endpoint; N is small). Clears the selection and refreshes on completion.
  const handleBulkStage = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        ids.map((id) =>
          fetch("/api/florists/stage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ floristId: id, stage: bulkStage }),
          })
        )
      );
      setSelectedIds(new Set());
      router.refresh();
    } catch {
      /* non-fatal: user can retry */
    } finally {
      setBulkBusy(false);
    }
  };

  const hasAnyFlorists = initialFlorists.length > 0;

  return (
    <div className="flex flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4 lg:overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link href="/discovery" className="eyebrow">
              ← Discovery
            </Link>
            {/* h1 is identity only (city name) — radius/region/ingested-at live
             * in the meta row below, not a header, per the brief's layout. */}
            <h1 className="truncate">
              {city.city}, {city.country}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setHowItWorksOpen(true)}
              className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft shadow-sm transition hover:bg-surface-2"
            >
              How it works
            </button>
            {/* Fix (current-code defect #9, superseded): re-run is now
             * fire-and-forget (POST /api/ingest returns a jobId immediately),
             * with progress surfaced in the shared JobsPanel drawer (now
             * shell-owned) instead of a blocking inline log — reusing
             * RerunCityButton's own busy-state + toast exactly as
             * CitiesTable/PipelineHome do. */}
            <RerunCityButton
              city={city}
              onRerunSuccess={handleRerunSuccess}
              className=""
              buttonClassName={RERUN_BUTTON_CLASSNAME}
              floristCount={initialFlorists.length}
            />
            {/* Next to Re-run because they answer the same question ("this
                city's data is stale/thin") with very different cost: a re-run
                re-scrapes and bills Apify, a repair only re-reads pages we
                already know about. */}
            <RepairButton
              scope="city"
              city={city}
              onSuccess={handleRerunSuccess}
              buttonClassName={RERUN_BUTTON_CLASSNAME}
            />
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
          <span className="tabular-nums">
            {city.radius_km != null ? `${city.radius_km} km radius` : "radius —"}
          </span>
          {city.region && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 font-medium text-ink-soft">
                {city.region}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>Last ingested {formatIngestedAt(city.ingested_at)}</span>
        </div>

        {hasAnyFlorists && (
          <div className="shrink-0">
            <CityVitalsBar
              stats={vitalsStats}
              shownCount={scoredSorted.length}
              totalCount={initialFlorists.length}
              onReset={handleReset}
            />
          </div>
        )}

        {hasAnyFlorists ? (
          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[auto_1fr]">
            <ControlsRail
              weights={weights}
              onWeightsChange={setWeights}
              selection={selection}
              onSelectionChange={setSelection}
              targetFlorist={targetFlorist}
              targetLabel={targetFlorist?.name ?? null}
            />

            <div className="flex min-h-0 flex-col gap-4">
              <div className="h-[340px] shrink-0 overflow-hidden rounded-lg border border-line shadow-sm">
                <Map
                  city={city}
                  florists={filtered}
                  spreadIds={spreadIds}
                  hoveredId={hoveredId}
                  selectedId={selectedFlorist?.id ?? null}
                  onHoverFlorist={setHoveredId}
                  onSelectFlorist={setSelectedFlorist}
                />
              </div>

              {selectedIds.size > 0 && (
                <div className="flex shrink-0 items-center justify-between rounded-lg border border-accent bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-4 py-2">
                  <span className="text-sm text-accent-ink">
                    <span className="font-medium tabular-nums">{selectedIds.size}</span>{" "}
                    {selectedIds.size === 1 ? "florist" : "florists"} selected
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Bulk stage move — pick a stage, apply to all selected. */}
                    <div className="flex items-center gap-1.5">
                      <label htmlFor="bulk-stage" className="sr-only">
                        Move selected florists to stage
                      </label>
                      <select
                        id="bulk-stage"
                        value={bulkStage}
                        onChange={(e) => setBulkStage(e.target.value as LifecycleStage)}
                        className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-ink-soft"
                      >
                        {LIFECYCLE_STAGES.map((s) => (
                          <option key={s} value={s}>
                            {STAGE_LABEL[s]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={handleBulkStage}
                        disabled={bulkBusy}
                        className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft shadow-sm hover:bg-surface-2 disabled:opacity-50"
                      >
                        {bulkBusy ? "Moving…" : `Move (${selectedIds.size})`}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set())}
                      className="text-sm text-accent hover:text-accent-ink"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => setPanelOpen(true)}
                      className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-accent-ink"
                    >
                      Review &amp; send ({selectedIds.size})
                    </button>
                  </div>
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
                <FloristTable
                  rows={scoredSorted}
                  spreadIds={spreadIds}
                  hoveredId={hoveredId}
                  selectedId={selectedFlorist?.id ?? null}
                  totalCount={initialFlorists.length}
                  onHoverFlorist={setHoveredId}
                  onSelectFlorist={setSelectedFlorist}
                  onReset={handleReset}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onToggleSelectAll={toggleSelectAll}
                  sentCountById={sentCountById}
                  onMarkTarget={handleMarkTarget}
                />
              </div>
            </div>
          </div>
        ) : (
          // Empty — zero florists ingested: replace the whole rail/map/table
          // area with EmptyState + a re-run CTA (reusing RerunCityButton so
          // it gets the same busy-state + toast as every other re-run).
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="w-full max-w-md">
              <EmptyState
                icon={<IconMapPin className="h-12 w-12 text-ink-faint" />}
                title="No florists ingested yet"
                description={`Run an ingest for ${city.city}, ${city.country} to start collecting florists — ratings, reachability, and outreach readiness will show up here.`}
                action={
                  <RerunCityButton
                    city={city}
                    onRerunSuccess={handleRerunSuccess}
                    className=""
                    floristCount={initialFlorists.length}
                  />
                }
              />
            </div>
          </div>
        )}
      </div>

      {selectedFlorist && (
        <ScoreBreakdown
          florist={selectedFlorist}
          weights={weights}
          outreach={outreach.filter((o) => o.florist_id === selectedFlorist.id)}
          onClose={() => setSelectedFlorist(null)}
          onExcluded={() => {
            setSelectedFlorist(null);
            router.refresh();
          }}
        />
      )}

      {howItWorksOpen && <HowDataCollectedModal onClose={() => setHowItWorksOpen(false)} />}

      {panelOpen && (
        <OutreachSendPanel
          florists={initialFlorists.filter((f) => selectedIds.has(f.id))}
          settings={settings}
          onClose={() => setPanelOpen(false)}
          onSent={() => {
            setSelectedIds(new Set());
            router.refresh();
          }}
          onDrafted={() => router.refresh()}
        />
      )}
    </div>
  );
}
