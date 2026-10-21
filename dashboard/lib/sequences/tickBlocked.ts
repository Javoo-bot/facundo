// Why a sequence tick returned without looking at a single enrolment.
//
// Its own module, with no "@/" imports, for two reasons: lib/sequences/tick.ts
// can't be reached by `node --test` (it pulls in the Supabase client), and both
// the engine and the /testing UI need this list. Keeping the reasons and their
// wording together is what lets the test below prove they can't drift apart.
//
// The problem this exists to solve: an all-zero TickResult was ambiguous. "The
// funnel is switched off" and "nothing happened to be due" produced identical
// output, so staff testing the funnel saw `ok` from every button, no email, and
// nothing anywhere naming the switch. That reads as a broken send, and it sent
// people looking in the wrong place three times over.

export const TICK_BLOCKED_REASONS = [
  "settings-unreadable",
  "sequence-disabled",
  "daily-cap",
] as const;

export type TickBlockedReason = (typeof TICK_BLOCKED_REASONS)[number];

/**
 * Plain-English for each reason. Every string NAMES THE FIX, because this is
 * read at the moment an expected email hasn't arrived — "disabled" alone just
 * restates the symptom.
 */
export const TICK_BLOCKED_COPY: Record<TickBlockedReason, string> = {
  "settings-unreadable":
    "did nothing — the settings row could not be read, so the engine failed closed.",
  "sequence-disabled":
    "did nothing — the recruiting funnel is switched off (Settings → Outreach).",
  "daily-cap":
    "did nothing — today's send cap is already used up (Settings → Outreach).",
};

/** Narrow an untrusted value (it arrives over JSON) to a known reason. */
export function isTickBlockedReason(value: unknown): value is TickBlockedReason {
  return typeof value === "string" && (TICK_BLOCKED_REASONS as readonly string[]).includes(value);
}

/** The sentence for a reason, or null if there isn't one — so a caller can fall
 *  back to printing the raw result rather than showing an empty explanation. */
export function tickBlockedCopy(value: unknown): string | null {
  return isTickBlockedReason(value) ? TICK_BLOCKED_COPY[value] : null;
}
