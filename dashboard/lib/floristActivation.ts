// Sprint 3 (onboarding rigor): a florist should never receive a real order
// until three things are true — they can log in, they can be located (a
// delivery radius is set), and they can be paid (a trust tier is assigned,
// which selects the payout split via trust_tiers). This mirrors the matcher's
// own hard filter (ingest-worker/src/match.ts::passesHardFilter, which now
// rejects delivery_radius_km == null and trust_tier == null) so staff can see
// in advance why a florist isn't matchable, rather than discovering it only
// when the matcher silently skips them.
//
// Lives in lib/ (not colocated in components/florist/floristOps.ts) because
// it's needed by the server page (app/(staff)/florists/[id]/page.tsx) as well
// as the client card — floristOps.ts is client-component-only helpers.
export interface ActivationCheck {
  label: string;
  met: boolean;
}

export interface ActivationStatus {
  activatable: boolean;
  checklist: ActivationCheck[];
}

export function computeActivation(
  florist: { delivery_radius_km: number | null; trust_tier: string | null },
  hasLogin: boolean
): ActivationStatus {
  const checklist: ActivationCheck[] = [
    { label: "Florist login linked", met: hasLogin },
    { label: "Delivery radius set", met: florist.delivery_radius_km != null },
    { label: "Trust tier assigned", met: florist.trust_tier != null },
  ];
  return { activatable: checklist.every((c) => c.met), checklist };
}
