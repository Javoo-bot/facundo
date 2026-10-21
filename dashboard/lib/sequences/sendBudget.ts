// How many recruiting emails today's tick is still allowed to send.
//
// Pure, and separated from tick.ts for the same reason openState.ts is: the
// interesting part is a three-state rule that is easy to get subtly wrong, and
// wrong here means either a campaign silently stopping at 200 or a kill switch
// that does not kill.
//
// THE THREE STATES
//
//   null  -> NO CEILING. The Reach Out campaign mails every shop a scrape
//            finds; a 1,500-shop scrape sends 1,500 emails, and Resend is
//            provisioned for that volume.
//   0     -> SEND NOTHING. The kill switch, and deliberately not the same as
//            null. Overloading 0 to mean "unlimited" would make the control
//            someone reaches for in a panic do the opposite of what they meant.
//   n > 0 -> the blast-radius guard it has always been.
//
// `undefined` is none of the three: it means the column did not come back in
// the settings read. That is not an instruction from anybody, so it falls back
// to the bounded default — a failed read must never be read as permission to
// send without limit.

/** The bounded default a missing/unreadable setting falls back to. Mirrors the
 * column default in supabase/schema.sql. */
export const DEFAULT_DAILY_SEND_CAP = 200;

/**
 * Remaining send budget for this tick.
 *
 * Returns `Infinity` for the uncapped case rather than a boolean the caller has
 * to keep re-checking: it survives `budget--` and never satisfies
 * `budget <= 0`, so the capped and uncapped paths are the same code and cannot
 * drift apart.
 *
 * @param rawCap     `app_settings.sequence_daily_send_cap` exactly as read.
 * @param sentToday  Recruiting sends already made this UTC day.
 */
export function remainingBudget(
  rawCap: number | null | undefined,
  sentToday: number
): number {
  if (rawCap === null) return Infinity;
  const cap = rawCap ?? DEFAULT_DAILY_SEND_CAP;
  // A negative cap is not meaningful; treat it as the kill switch rather than
  // letting it produce a budget that looks merely "very spent".
  if (cap <= 0) return 0;
  return cap - Math.max(0, sentToday);
}

/** Whether the cap alone stops this tick, before any row is considered. Kept
 * beside the arithmetic so "capped" means one thing in one place. */
export function isCapped(budget: number): boolean {
  return budget <= 0;
}
