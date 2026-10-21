// Test-store scenarios: the states a florist can be in that the flows care
// about, as data rather than as a runbook nobody follows the same way twice.
//
// Pure and alias-free so `node --test` reaches it. The route turns a scenario
// into rows; this file only says what each state IS.
//
// WHY PRESETS AND NOT A FORM WITH TWENTY FIELDS: the interesting states are few
// and specific, and every one of them is a combination of `joined_at`, whether
// they were ever offered anything, and whether they ever accepted. Getting one
// of those three wrong produces a shop that looks right and silently exercises
// a different branch — e.g. a "dormant partner" with no accepted order is
// actually a never-accepted shop, and the reactivation classifier will correctly
// send it the other sequence while you wonder why.

export type ScenarioId =
  | "fresh_prospect"
  | "engaged_prospect"
  | "joined_never_accepted"
  | "dormant_partner"
  | "cold_offer_target";

export interface Scenario {
  id: ScenarioId;
  label: string;
  /** What this shop is, in one line, on the card. */
  blurb: string;
  /** What running the flows on it should demonstrate. */
  expect: string;
  /** Days ago the shop joined the network. Null = never joined. */
  joinedDaysAgo: number | null;
  /** Give it a declined assignment, so it counts as "has been offered". */
  seedDeclinedOffer: boolean;
  /** Days ago it last accepted an order. Null = never accepted. */
  lastAcceptedDaysAgo: number | null;
  /** Enrol it in this sequence on creation. Null = leave it unenrolled. */
  enrolIn: string | null;
  /** Mark the enrolment as already clicked. */
  engaged: boolean;
  /** Needs coordinates — the cold-offer eligibility check requires them. */
  needsCoords: boolean;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "fresh_prospect",
    label: "Fresh prospect",
    blurb: "Discovered, never contacted, not in the network.",
    expect: "Enrol it and the cold track runs: t1 at day 0, t2 at day 3, t3 at day 7, then exhausted.",
    joinedDaysAgo: null,
    seedDeclinedOffer: false,
    lastAcceptedDaysAgo: null,
    enrolIn: null,
    engaged: false,
    needsCoords: false,
  },
  {
    id: "engaged_prospect",
    label: "Engaged prospect",
    blurb: "Cold prospect who has already clicked a link.",
    expect: "Skips the rest of the cold track. r1 two days after the click on email + SMS, r2 three days later.",
    joinedDaysAgo: null,
    seedDeclinedOffer: false,
    lastAcceptedDaysAgo: null,
    enrolIn: "recruit_cold",
    engaged: true,
    needsCoords: false,
  },
  {
    id: "joined_never_accepted",
    label: "Joined, no first order",
    blurb: "In the network, has been offered orders, never took one.",
    expect: "Reactivation A: ra1 immediately, ra2 seven days later. NOT the dormant copy.",
    joinedDaysAgo: 60,
    seedDeclinedOffer: true,
    lastAcceptedDaysAgo: null,
    enrolIn: null,
    engaged: false,
    needsCoords: false,
  },
  {
    id: "dormant_partner",
    label: "Dormant partner",
    blurb: "Delivered for us before, then went quiet.",
    expect: "Reactivation D: rd1 immediately, rd2 ten days later. Never the never-accepted copy.",
    joinedDaysAgo: 300,
    seedDeclinedOffer: true,
    lastAcceptedDaysAgo: 120,
    enrolIn: null,
    engaged: false,
    needsCoords: false,
  },
  {
    id: "cold_offer_target",
    label: "Cold-offer target",
    blurb: "Outside the network, locatable, eligible for a real order.",
    expect: "With cold offers on, the wave engine can offer it a live order; accepting mints tier 5 and holds the payout.",
    joinedDaysAgo: null,
    seedDeclinedOffer: false,
    lastAcceptedDaysAgo: null,
    enrolIn: null,
    engaged: false,
    needsCoords: true,
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function isScenarioId(x: unknown): x is ScenarioId {
  return typeof x === "string" && SCENARIOS.some((s) => s.id === x);
}

/** How far back to shift a run so the next touch is due NOW.
 *
 * The funnel's clocks are anchored to real timestamps, so the only honest way
 * to test a 7-day sequence in an afternoon is to move the anchors backwards —
 * NOT to shorten the intervals, which would test a funnel you are not going to
 * ship. Returns the milliseconds to subtract from every anchor on the row. */
export function fastForwardMs(days: number): number {
  const d = Number.isFinite(days) ? Math.max(0, Math.min(400, days)) : 0;
  return d * 24 * 60 * 60 * 1000;
}
