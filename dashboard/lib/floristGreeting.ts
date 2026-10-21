/** Time-of-day greeting for the public join form
 * (app/florist/accept/[token]).
 *
 * The clock that matters is the SHOP's, not the server's — we render this on
 * the server and the shop can be eight timezones away. lib/floristTime.ts turns
 * the stored lat/lng into an IANA zone offline (tz-lookup, no API), and this
 * turns a zone plus an instant into a greeting bucket.
 *
 * Returns null rather than guessing when we can't know the local hour, exactly
 * like formatOfferDeadline: no coordinates, or a zone Intl doesn't recognise.
 * The page falls back to the browser clock in that case (see
 * components/florist/Greeting.tsx) — the florist is filling the form on their
 * own device, so it's a good second-best.
 *
 * Relative imports only (no "@/..."), so plain `node --test` can reach it.
 * `nowMs` is injectable for the same reason. */

export const GREETING_KEYS = ["morning", "afternoon", "evening", "night"] as const;
export type GreetingKey = (typeof GREETING_KEYS)[number];

/** The local hour (0–23) in `tz` at `ms`, or null when the zone is unusable. */
function localHour(ms: number, tz: string): number | null {
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
    const hour = Number(formatted);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  } catch {
    return null;
  }
}

/** Which greeting an hour falls in.
 *
 * `night` (22:00–04:59) is its own bucket rather than part of `evening`
 * because English "Good night" is a farewell — that key resolves to a neutral
 * "Hello" in the copy. Other locales pick whatever a person arriving at 01:00
 * would actually be told. */
export function greetingKeyForHour(hour: number): GreetingKey {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

/** The greeting for a shop in `tz` at `nowMs`, or null when we can't tell. */
export function greetingKey(tz: string | null, nowMs: number = Date.now()): GreetingKey | null {
  if (!tz) return null;
  if (!Number.isFinite(nowMs)) return null;
  const hour = localHour(nowMs, tz);
  return hour === null ? null : greetingKeyForHour(hour);
}
