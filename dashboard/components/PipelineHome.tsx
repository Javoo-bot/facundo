"use client";

import { useMemo, useState } from "react";
import AddCityDialog from "@/components/AddCityDialog";
import RepairButton from "@/components/RepairButton";
import CitiesTable from "@/components/CitiesTable";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import EngagementList from "@/components/pipeline/EngagementList";
import StagePlaceholder from "@/components/pipeline/StagePlaceholder";
import StageTile from "@/components/pipeline/StageTile";
import StatTile from "@/components/StatTile";
import {
  IconBuildingStorefront,
  IconGlobe,
  IconLayers,
  IconMail,
  IconMapPin,
  IconPhone,
  IconPlus,
  IconShoppingCart,
  IconStar,
  IconUsers,
} from "@/components/icons";
import { coverageBand, ratingBand, type CoverageBand, type RatingBand } from "@/lib/bands";
import { PHASE_LABEL, PHASES, phaseCounts, phaseOf, type Phase } from "@/lib/pipeline";
import { aggregateFlorists, computeGlobalSummary, groupCitiesByCountryAndRegion } from "@/lib/stats";
import type { City, PipelineFlorist } from "@/lib/types";

function formatRating(rating: number | null): string {
  return rating == null ? "—" : rating.toFixed(1);
}

const PHASE_SUB: Record<Phase, string> = {
  discovery: "found · targeted · contacted",
  engagement: "in conversation",
  onboarding: "getting set up",
  production: "live partners",
};

// Module-level (not nested inside PipelineHome) so it isn't re-created every
// render — a component defined inside another component's render body would
// remount its whole subtree (losing DOM state, defocusing inputs, retriggering
// effects) on every parent re-render.
function DiscoveryView({
  cities,
  summary,
  groups,
  fetchError,
  ratingAccent,
  coverageAccent,
  onAddCity,
}: {
  cities: City[];
  summary: ReturnType<typeof computeGlobalSummary>;
  groups: ReturnType<typeof groupCitiesByCountryAndRegion>;
  fetchError: boolean;
  ratingAccent: RatingBand;
  coverageAccent: CoverageBand;
  onAddCity: () => void;
}) {
  return (
    <>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <StatTile label="Countries" value={summary.countries} accent="emerald" icon={<IconGlobe className="h-4 w-4" />} />
        <StatTile label="Regions" value={summary.regions} accent="emerald" icon={<IconLayers className="h-4 w-4" />} />
        <StatTile label="Cities" value={summary.cities} accent="emerald" icon={<IconBuildingStorefront className="h-4 w-4" />} />
        <StatTile label="Florists" value={summary.totalFlorists} accent="slate" icon={<IconUsers className="h-4 w-4" />} />
        <StatTile label="Reachable" value={summary.totalReachable} accent={coverageAccent} icon={<IconPhone className="h-4 w-4" />} />
        <StatTile label="Ecommerce" value={summary.totalEcommerce} accent="indigo" icon={<IconShoppingCart className="h-4 w-4" />} />
        <StatTile label="Drafts ready" value={summary.draftsReady} accent="emerald" icon={<IconMail className="h-4 w-4" />} />
        <StatTile
          label="Avg rating"
          value={summary.overallAvgRating != null ? `★ ${formatRating(summary.overallAvgRating)}` : "—"}
          accent={ratingAccent}
          icon={<IconStar className="h-4 w-4" />}
        />
      </section>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold text-ink">Cities</h2>
            {!fetchError && (
              <p className="text-xs text-ink-soft">
                {summary.cities} {summary.cities === 1 ? "city" : "cities"} · {summary.countries}{" "}
                {summary.countries === 1 ? "country" : "countries"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Repair sits beside Add city because both are "get more
                reachable florists" — but it adds no city and spends nothing on
                Apify. It labels itself with the count and disables at zero, so
                it reads as a no-op when there is nothing broken. */}
            <RepairButton scope="all" onSuccess={() => window.location.reload()} />
            <button
              type="button"
              onClick={onAddCity}
              aria-label="Add city"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-accent-ink active:scale-[0.98]"
            >
              <IconPlus className="h-4 w-4" />
              <span>Add city</span>
            </button>
          </div>
        </div>

        {fetchError ? (
          <ErrorState />
        ) : cities.length === 0 ? (
          <EmptyState
            icon={<IconMapPin className="h-12 w-12 text-ink-faint" />}
            title="No cities yet"
            description="Add a city to start ingesting florists — ratings, reachability, and outreach readiness will show up here once it's ingested."
            cta={{ label: "Add city", onClick: onAddCity, icon: <IconPlus className="h-4 w-4" /> }}
          />
        ) : (
          <CitiesTable groups={groups} onRerunSuccess={() => window.location.reload()} />
        )}
      </section>
    </>
  );
}

export default function PipelineHome({
  cities,
  florists,
  fetchError,
}: {
  cities: City[];
  florists: PipelineFlorist[];
  fetchError: boolean;
}) {
  const [addCityOpen, setAddCityOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("discovery");

  // /discovery already holds the rows (it groups them per city), so it derives
  // the aggregates locally rather than making a second round trip.
  const summary = useMemo(() => computeGlobalSummary(cities, aggregateFlorists(florists)), [cities, florists]);
  const groups = useMemo(
    () => groupCitiesByCountryAndRegion(cities, florists),
    [cities, florists]
  );
  const counts = useMemo(() => phaseCounts(florists.map((f) => f.lifecycle_stage)), [florists]);
  const lostCount = useMemo(
    () => florists.filter((f) => phaseOf(f.lifecycle_stage) === "lost").length,
    [florists]
  );

  const floristsInPhase = (p: Phase) => florists.filter((f) => phaseOf(f.lifecycle_stage) === p);

  const ratingAccent = ratingBand(summary.overallAvgRating);
  const coverageAccent = coverageBand(
    summary.totalFlorists > 0 ? (summary.totalReachable / summary.totalFlorists) * 100 : null
  );

  return (
    <div>
      {/* Header/top bar (title, Orders/CX/Trust-tiers links, JobsPanel,
       * UserMenu) moved to the staff shell (components/shell/StaffShell.tsx)
       * — this component now only owns the pipeline tiles + phase view body,
       * rendered inside the shell's <main>. */}
      <div inert={addCityOpen}>
        <main className="mx-auto max-w-[1440px] px-6 py-6">
          {/* Pipeline tiles */}
          <section className="flex flex-wrap gap-3">
            {PHASES.map((p) => (
              <StageTile
                key={p}
                label={PHASE_LABEL[p]}
                count={counts[p]}
                sub={PHASE_SUB[p]}
                active={phase === p}
                onClick={() => setPhase(p)}
              />
            ))}
          </section>
          {lostCount > 0 && (
            <p className="mt-2 text-xs text-ink-faint">
              {lostCount} florist{lostCount === 1 ? "" : "s"} marked lost (visible on their cards).
            </p>
          )}

          {/* Selected-phase view */}
          <div className="mt-6">
            {phase === "discovery" && (
              <DiscoveryView
                cities={cities}
                summary={summary}
                groups={groups}
                fetchError={fetchError}
                ratingAccent={ratingAccent}
                coverageAccent={coverageAccent}
                onAddCity={() => setAddCityOpen(true)}
              />
            )}
            {phase === "engagement" && (
              <EngagementList
                florists={floristsInPhase("engagement")}
                cities={cities}
                emptyLabel="No florists in Engagement yet — move a contacted florist here from its card when they reply."
              />
            )}
            {phase === "onboarding" && (
              <StagePlaceholder title="Onboarding" florists={floristsInPhase("onboarding")} cities={cities} />
            )}
            {phase === "production" && (
              <StagePlaceholder title="Production" florists={floristsInPhase("production")} cities={cities} />
            )}
          </div>
        </main>
      </div>

      {addCityOpen && (
        <AddCityDialog onClose={() => setAddCityOpen(false)} onIngestSuccess={() => window.location.reload()} />
      )}
    </div>
  );
}
