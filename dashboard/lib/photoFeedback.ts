// Turning a photo_verifications row into something the FLORIST can act on.
//
// Before this, a held delivery leg showed exactly one sentence — "Your 30%
// releases once Facundo confirms the delivery photo" — and no way forward.
// That is the same message whether the photo was the wrong bouquet, whether
// half the order was missing from the frame, or whether our own verifier fell
// over and never looked at it. The florist is left waiting on money with no
// idea whether waiting is even the right thing to do.
//
// So: name the reason, list what wasn't visible, and — when a different photo
// could plausibly change the answer — let them send one. Capped, because
// "retry until the model says yes" is not a review process.
//
// Pure: no DB, no network, no imports. Unit-tested under `node --test`.

export type PhotoFeedbackCode =
  /** No provider returned a usable answer — OUR failure, nobody judged the photo. */
  | "not_checked"
  /** Providers were confident the photo shows a different arrangement. */
  | "no_match"
  /** Recognisable, but things the order asked for weren't visible. */
  | "incomplete"
  /** Too unclear/low-confidence to call either way. */
  | "unsure";

/** How many delivery photos a florist may send on one assignment before it
 *  stops being a retry loop and becomes a conversation with a human. The first
 *  upload counts, so this allows two re-uploads. */
export const MAX_PHOTO_ATTEMPTS = 3;

/** Cap on how many "not visible" lines we echo back — the models can be verbose
 *  and this renders on a phone at a doorstep. */
const MAX_MISSING = 6;

export interface ProviderJudgment {
  ok?: boolean | null;
  matched?: boolean | null;
  confidence?: number | null;
  itemsMissing?: unknown;
  notes?: string | null;
  error?: string | null;
}

export interface VerificationRow {
  verdict?: string | null;
  confidence?: number | null;
  providers?: unknown;
}

export interface PhotoFeedback {
  code: PhotoFeedbackCode;
  /** Deduped, trimmed, capped list of what at least one provider couldn't see. */
  missing: string[];
  /** True when the verdict is about OUR pipeline, not about their photo. Callers
   *  use it to apologise rather than accuse. */
  ourFault: boolean;
}

function asJudgments(providers: unknown): ProviderJudgment[] {
  return Array.isArray(providers) ? (providers.filter((p) => p && typeof p === "object") as ProviderJudgment[]) : [];
}

function missingFrom(judgments: ProviderJudgment[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const j of judgments) {
    if (!Array.isArray(j.itemsMissing)) continue;
    for (const raw of j.itemsMissing) {
      if (typeof raw !== "string") continue;
      const item = raw.trim();
      // Case-insensitive dedupe: two providers describing the same gap in
      // different capitalisation is one gap, not two.
      const key = item.toLowerCase();
      if (!item || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= MAX_MISSING) return out;
    }
  }
  return out;
}

/**
 * Why this photo didn't release the 30%. `null` when there is nothing to
 * explain (no verification row, or it passed).
 */
export function photoFeedback(row: VerificationRow | null | undefined): PhotoFeedback | null {
  if (!row) return null;
  const verdict = row.verdict ?? null;
  if (verdict !== "review" && verdict !== "fail") return null;

  const all = asJudgments(row.providers);
  const usable = all.filter((p) => p.ok === true);

  // Nothing looked at it. This is the case that read as "under review" while no
  // review was pending or possible — the honest answer is that we failed.
  if (usable.length === 0) return { code: "not_checked", missing: [], ourFault: true };

  if (verdict === "fail") return { code: "no_match", missing: missingFrom(usable), ourFault: false };

  const missing = missingFrom(usable);
  if (missing.length > 0) return { code: "incomplete", missing, ourFault: false };
  return { code: "unsure", missing: [], ourFault: false };
}

/** What the florist-facing UI needs to explain a held delivery leg: the reason,
 *  what wasn't visible, and whether sending another photo is still on offer. */
export interface PhotoReview extends PhotoFeedback {
  canReupload: boolean;
  attemptsLeft: number;
}

/**
 * Whether the "delivery submitted, under review" panel should be on screen.
 *
 * Pulled out of the component because getting it wrong is silent and lands on
 * the florist: the panel is driven partly by CLIENT state (`sessionHeldNotice`,
 * set when an upload comes back held) which does not reset itself, so after a
 * re-upload released the money the stale flag kept telling them their 30% was
 * under review. Money that has actually moved is the strongest possible
 * evidence that nothing is pending, so it wins over any client state.
 */
export function heldPanelVisible(input: {
  accepted: boolean;
  /** Client-side flag from the last upload in this session. */
  sessionHeldNotice: boolean;
  /** Status of the actionable delivery leg, or null when there is none. */
  deliveryStatus?: string | null;
}): boolean {
  if (!input.accepted) return false;
  const s = input.deliveryStatus ?? null;
  if (s === "issued" || s === "paid") return false; // paid: nothing is under review
  return input.sessionHeldNotice || s === "held";
}

export interface ReuploadInput {
  /** How many delivery photos have already been verified on this assignment. */
  attempts: number;
  /** Status of the delivery payout leg, or null when no leg exists yet. */
  payoutStatus?: string | null;
}

export interface ReuploadDecision {
  allowed: boolean;
  attemptsLeft: number;
  /** Why not, when `allowed` is false. */
  reason?: "already-paid" | "no-attempts-left";
}

/**
 * Whether the florist may send another delivery photo.
 *
 * Money that has already moved is final — a re-upload after `issued`/`paid`
 * would be re-litigating a settled leg, and there is nothing left to release.
 * Otherwise they get MAX_PHOTO_ATTEMPTS tries in total, after which the hold
 * stands and a human picks it up (which is what the hold was always for).
 */
export function reuploadDecision(input: ReuploadInput): ReuploadDecision {
  const attempts = Math.max(0, Math.floor(input.attempts));
  const attemptsLeft = Math.max(0, MAX_PHOTO_ATTEMPTS - attempts);
  const status = input.payoutStatus ?? null;
  if (status === "issued" || status === "paid" || status === "pending") {
    return { allowed: false, attemptsLeft, reason: "already-paid" };
  }
  if (attemptsLeft <= 0) return { allowed: false, attemptsLeft: 0, reason: "no-attempts-left" };
  return { allowed: true, attemptsLeft };
}
