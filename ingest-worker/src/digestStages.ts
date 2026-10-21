// The six journey stages an order passes through, for the daily digest.
//
// DELIBERATE DUPLICATE of dashboard/lib/orderStages.ts::STAGES, for the same
// reason workingSet.ts and monitor.ts are duplicated: the Worker cannot import
// across the package boundary. `test/digest.test.ts` asserts the IDS have not
// drifted from that file, so a rename there fails CI here.
//
// THE LABELS HAVE DELIBERATELY DIVERGED, and the ids have not.
//
// CX read the 2026-08-27 digest and could not say what "Fulfilment" or
// "Outreach" meant, which is fatal for a mail whose whole job is to be
// understood in five seconds. The email's labels now name an event a person
// recognises ("Florist accepted", "Offer sent") rather than a phase of our
// pipeline. The order page still says Fulfilment and Outreach; the email leads
// and the dashboard follows in a separate change, because renaming the
// stepper is a visible change to a screen staff use all day and did not need
// to be coupled to this one. The ids are what both sides key off, so nothing
// downstream can care which words are shown.
//
// WHY THE DIGEST REUSES THE STEPPER'S VOCABULARY
//
// The metric this replaces printed a share ("13% ran without us"), which said
// nothing about WHERE the loop gave up, and an earlier draft printed a mean
// ("2.2 of 6 steps"), which is worse: averaging positions on an ordinal scale
// invents a state that does not exist, and 2.2 is not a stage anybody can point
// at. Naming the stage fixes both, and naming it with the SAME word the order
// page's stepper uses means nobody has to learn a second vocabulary.
//
// STAGE IS DERIVED FROM EVIDENCE, NOT FROM `orders.status`.
//
// Two of the five orders taken on 2026-08-26 sit at `escalated`, which is not a
// position on the stepper but an overlay on top of one, so reading the current
// status would lose where they actually got to. `stageFromEvidence` below reads
// the assignments and events instead, which cannot be overwritten by a later
// status change.

export type StageId = "created" | "matched" | "outreach" | "fulfilment" | "delivery" | "delivered";

/** In journey order. The index IS the ordinal, so never reorder this. */
export const STAGES: { id: StageId; label: string }[] = [
  { id: "created", label: "Taken on" },
  { id: "matched", label: "Matched" },
  { id: "outreach", label: "Offer sent" },
  { id: "fulfilment", label: "Florist accepted" },
  { id: "delivery", label: "Out for delivery" },
  { id: "delivered", label: "Delivered" },
];

export function stageIndex(id: StageId): number {
  return STAGES.findIndex((s) => s.id === id);
}

export function stageLabel(id: StageId): string {
  return STAGES[stageIndex(id)].label;
}

/** What is known to have happened to an order, one flag per stage past Created. */
export interface StageEvidence {
  /** A candidate florist was written. */
  matched: boolean;
  /** An offer actually went out to one of them. */
  outreach: boolean;
  /** A florist accepted. */
  fulfilment: boolean;
  /** Marked out for delivery. */
  delivery: boolean;
  /**
   * Delivered by us.
   *
   * Deliberately NOT satisfied by `orders.status = 'closed'`, even though
   * dashboard/lib/orderStages.ts groups `closed` under Delivered: over the 46
   * orders CX took on between 11 and 26 Aug 2026, 27 were `closed` and 26 of
   * those had no `delivered_photo` at all. They were fulfilled through some
   * other channel, and counting them as delivered would report the loop
   * completing work it never did. The digest already keeps them apart in its
   * own `closedUpstream` bucket; this keeps the stage honest too.
   */
  delivered: boolean;
}

/** The furthest stage this evidence supports. Consecutive: a gap stops the walk. */
export function stageFromEvidence(e: StageEvidence): StageId {
  if (e.delivered) return "delivered";
  if (e.delivery) return "delivery";
  if (e.fulfilment) return "fulfilment";
  if (e.outreach) return "outreach";
  if (e.matched) return "matched";
  return "created";
}

/** The furthest stage reached across a set, and how many orders got there. */
export function furthest(stages: StageId[]): { stage: StageId; count: number } {
  let best: StageId = "created";
  for (const s of stages) if (stageIndex(s) > stageIndex(best)) best = s;
  const bestIndex = stageIndex(best);
  return { stage: best, count: stages.filter((s) => stageIndex(s) >= bestIndex).length };
}

/** How many orders passed THROUGH each stage, in STAGES order (cumulative). */
export function passedThrough(stages: StageId[]): number[] {
  return STAGES.map((_, i) => stages.filter((s) => stageIndex(s) >= i).length);
}
