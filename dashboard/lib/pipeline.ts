import type { LifecycleStage } from "./types";

// Ordered lifecycle. `lost` is a side state (off-funnel), listed last.
export const LIFECYCLE_STAGES: LifecycleStage[] = [
  "found",
  "targeted",
  "contacted",
  "engaged",
  "onboarding",
  "production",
  "lost",
];

export type Phase = "discovery" | "engagement" | "onboarding" | "production";
export const PHASES: Phase[] = ["discovery", "engagement", "onboarding", "production"];

// Stage → macro-phase. `lost` belongs to no phase tile.
export const STAGE_PHASE: Record<LifecycleStage, Phase | "lost"> = {
  found: "discovery",
  targeted: "discovery",
  contacted: "discovery",
  engaged: "engagement",
  onboarding: "onboarding",
  production: "production",
  lost: "lost",
};

export const PHASE_LABEL: Record<Phase, string> = {
  discovery: "Discovery",
  engagement: "Engagement",
  onboarding: "Onboarding",
  production: "Production",
};

export const STAGE_LABEL: Record<LifecycleStage, string> = {
  found: "Found",
  targeted: "Targeted",
  contacted: "Contacted",
  engaged: "Engaged",
  onboarding: "Onboarding",
  production: "Production",
  lost: "Lost",
};

export function isLifecycleStage(v: unknown): v is LifecycleStage {
  return typeof v === "string" && (LIFECYCLE_STAGES as string[]).includes(v);
}

// The single automation: a sent reach-out advances only these stages.
export const BUMP_TO_CONTACTED_FROM: LifecycleStage[] = ["found", "targeted"];
export function shouldBumpToContacted(current: string | null | undefined): boolean {
  return (BUMP_TO_CONTACTED_FROM as string[]).includes(current ?? "");
}

// Self-registration (dashboard/app/api/florist/accept) advances only these
// stages to 'onboarding' — deliberately never 'production' (see
// lib/lifecycle.ts's match-unready-florist note): only the florist has
// confirmed anything at this point, no staff vetting yet. Never downgrades a
// florist already onboarding/production/lost.
export const BUMP_TO_ONBOARDING_FROM: LifecycleStage[] = ["found", "targeted", "contacted", "engaged"];
export function shouldBumpToOnboarding(current: string | null | undefined): boolean {
  return (BUMP_TO_ONBOARDING_FROM as string[]).includes(current ?? "");
}

// A null/unknown stage is treated as 'found' (the column default) so a row is
// never dropped from the funnel.
export function phaseOf(stage: string | null | undefined): Phase | "lost" {
  const s = (stage ?? "found") as LifecycleStage;
  return STAGE_PHASE[s] ?? "discovery";
}

export function phaseCounts(stages: (string | null | undefined)[]): Record<Phase, number> {
  const counts: Record<Phase, number> = {
    discovery: 0,
    engagement: 0,
    onboarding: 0,
    production: 0,
  };
  for (const s of stages) {
    const p = phaseOf(s);
    if (p !== "lost") counts[p] += 1;
  }
  return counts;
}
