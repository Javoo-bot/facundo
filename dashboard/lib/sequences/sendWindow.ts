// When a recruiting touch is allowed to go out.
//
// Pure and alias-free (no I/O, `now` always passed in) so the window is
// executable in a unit test — same contract as schedule.ts, which calls it.
//
// ---- Why this exists at all
//
// The tick fires every minute, all day and all night, and until now that was
// harmless: on a day-0/3/7 funnel, a touch landing at 03:00 is a cosmetic wart.
// The one-day funnel makes it a correctness bug. Its whole premise is "we
// waited 3½ hours, they did not open it, so send the different email" — and a
// shop mailed at 02:00 is judged a non-opener at 05:30, before anyone could
// have opened anything. Without a window the open gate does not measure
// interest, it measures what time we happened to enrol them.
//
// ---- Why one timezone
//
// Europe/Madrid for the whole campaign. `cities` has no timezone column and
// florists carry no country of their own, and inventing per-city timezones for
// a Spain push would be a lot of machinery for a country that is one zone.
// (The Canaries are an hour behind peninsular Spain; a Canarian shop therefore
// gets its 09:00 mail at 08:00 local. That is a deliberate, bounded trade —
// still inside a plausible working morning, unlike the 02:00 case this file
// exists to prevent. If the campaign ever leaves Spain, this is the seam where
// a per-city zone would go.)
//
// Computed from the timezone NAME via Intl, never a fixed UTC offset, so the
// late-October DST change needs no thought and no dated special case.

/** Business hours, local time, inclusive of the open and exclusive of the close.
 * 09:00 is the morning inbox check; 20:00 is late enough for the click branch
 * to finish the same evening and early enough that nothing lands overnight. */
export const WINDOW_OPEN_HOUR = 9;
export const WINDOW_CLOSE_HOUR = 20;

export const CAMPAIGN_TIME_ZONE = "Europe/Madrid";

/** The wall-clock parts of `ms` in `timeZone`. Intl is the only DST-correct
 * source available without a dependency; `en-CA` because it formats as
 * YYYY-MM-DD, and `hour12: false` because `hourCycle` is not honoured
 * consistently across runtimes. Hour 24 is Intl's midnight in some engines —
 * normalised to 0 so callers never see it. */
function parts(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const got: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== "literal") got[p.type] = p.value;
  return {
    year: Number(got.year), month: Number(got.month), day: Number(got.day),
    hour: Number(got.hour) % 24, minute: Number(got.minute),
  };
}

/** The UTC instant of a given local wall-clock time in `timeZone`.
 *
 * Inverting a timezone is not algebraic — the offset depends on the instant you
 * are solving for — so this guesses, measures the error, corrects, and measures
 * again. Two passes settle every real case including both DST edges: the first
 * correction lands within an hour, the second fixes the boundary itself. */
function instantOf(
  y: number, mo: number, d: number, h: number, mi: number, timeZone: string
): number {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, timeZone);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const drift = actual - target;
    if (drift === 0) break;
    guess -= drift;
  }
  return guess;
}

export interface WindowOptions {
  timeZone?: string;
  openHour?: number;
  closeHour?: number;
}

/** Is `ms` inside business hours? */
export function isWithinWindow(ms: number, opts: WindowOptions = {}): boolean {
  const { timeZone = CAMPAIGN_TIME_ZONE, openHour = WINDOW_OPEN_HOUR, closeHour = WINDOW_CLOSE_HOUR } = opts;
  const h = parts(ms, timeZone).hour;
  return h >= openHour && h < closeHour;
}

/**
 * The first moment at or after `ms` that a touch may be sent.
 *
 * Returns `ms` unchanged when it is already inside the window — the common
 * case, and the one that must not shift a due time by even a millisecond, or
 * every step's clock would drift a little each hop.
 *
 * Before the window → today's open. At or after it → tomorrow's open, found by
 * stepping the LOCAL calendar day rather than adding 24h, because on a DST
 * boundary the next day is 23 or 25 hours away and adding a fixed 24 would
 * silently produce 08:00 or 10:00.
 */
export function nextSendTime(ms: number, opts: WindowOptions = {}): number {
  const { timeZone = CAMPAIGN_TIME_ZONE, openHour = WINDOW_OPEN_HOUR, closeHour = WINDOW_CLOSE_HOUR } = opts;
  const p = parts(ms, timeZone);
  if (p.hour < openHour) {
    return instantOf(p.year, p.month, p.day, openHour, 0, timeZone);
  }
  if (p.hour >= closeHour) {
    // Midday of the same local day, then +1 day, then re-read: midday is far
    // enough from both DST boundaries that adding 24h cannot land on the wrong
    // calendar date, which is the only thing this step needs to get right.
    const noon = instantOf(p.year, p.month, p.day, 12, 0, timeZone);
    const t = parts(noon + 24 * 60 * 60 * 1000, timeZone);
    return instantOf(t.year, t.month, t.day, openHour, 0, timeZone);
  }
  return ms;
}
