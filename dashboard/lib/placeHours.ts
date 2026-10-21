/** Google Places `regularOpeningHours` → our `florists.business_hours`.
 *
 * This is the FIRST automated source of opening hours the system has ever had:
 * the Apify ingest never captured them, so until now `business_hours` came only
 * from staff seeds and from florists filling in the join form themselves.
 *
 * Relative imports only (no "@/..."), so plain `node --test` can reach it —
 * same constraint as lib/businessHours.ts, which owns the storage format.
 *
 * The governing rule, borrowed from businessHours.ts::toDayRows: map the shapes
 * we understand and DROP everything else, so the join form falls back to its
 * defaults for the florist to correct. A wrong opening hour is worse than a
 * blank one — blank asks a question, wrong states a falsehood about when
 * someone can be sent an order.
 */

import { HOUR_DAYS, type BusinessHours, type HourDay } from "./businessHours.ts";

/** One Places period. `close` is absent for a place open 24 hours.
 * `day` is 0..6 with **0 = Sunday** — see PLACES_DAY_TO_OURS. */
export interface PlacePeriodPoint {
  day?: number;
  hour?: number;
  minute?: number;
}
export interface PlacePeriod {
  open?: PlacePeriodPoint;
  close?: PlacePeriodPoint;
}

/** Places numbers its week from Sunday; HOUR_DAYS starts Monday. Getting this
 * wrong shifts a shop's entire week by one day, silently and plausibly — the
 * exact bug class this table exists to make impossible to write by accident. */
const PLACES_DAY_TO_OURS: readonly HourDay[] = [
  "sun", // 0
  "mon", // 1
  "tue", // 2
  "wed", // 3
  "thu", // 4
  "fri", // 5
  "sat", // 6
];

const pad = (n: number) => String(n).padStart(2, "0");

function hhmm(p: PlacePeriodPoint | undefined): string | null {
  if (!p || typeof p.hour !== "number") return null;
  const hour = p.hour;
  const minute = typeof p.minute === "number" ? p.minute : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

function dayOf(p: PlacePeriodPoint | undefined): HourDay | null {
  if (!p || typeof p.day !== "number") return null;
  return PLACES_DAY_TO_OURS[p.day] ?? null;
}

/** What we could not represent, so the caller can say so rather than imply the
 * import was complete. */
export interface PlaceHoursResult {
  hours: BusinessHours | null;
  /** Days present in the Places response that we deliberately did not import,
   * with why — surfaced in the create dialog so staff know to ask. */
  skipped: { day: HourDay; reason: string }[];
}

/**
 * Four shapes Places returns that are NOT a plain single range, and what we do:
 *
 *   - **Open 24 hours** — one period with an `open` and no `close`. Imported as
 *     00:00-23:59. (Not "closed", which is the opposite, and not dropped: it is
 *     unambiguous.)
 *   - **Overnight** — `close.day !== open.day`, e.g. Fri 18:00 → Sat 02:00.
 *     Dropped. Our format is one day's own clock and cannot say "until 02:00
 *     tomorrow"; storing 18:00-02:00 would fail the close-after-open rule
 *     everywhere else in the codebase.
 *   - **Split shift** — two periods on one day, the Mediterranean lunch
 *     closure and the single most common reason this mapper exists. Imported
 *     as the two-range form ("09:00-13:00,16:00-20:00"), see businessHours.ts.
 *   - **Three or more periods** — real but vanishingly rare. Dropped rather
 *     than silently truncated to the first two.
 *
 * A day absent from `periods` entirely is CLOSED — that is what Places means by
 * omitting it, and it is a fact worth storing rather than leaving unknown.
 */
export function placeHoursToBusinessHours(periods: PlacePeriod[] | null | undefined): PlaceHoursResult {
  if (!Array.isArray(periods) || periods.length === 0) return { hours: null, skipped: [] };

  const byDay = new Map<HourDay, { open: string; close: string }[]>();
  const skipped: { day: HourDay; reason: string }[] = [];
  const skip = (day: HourDay, reason: string) => {
    if (!skipped.some((s) => s.day === day)) skipped.push({ day, reason });
  };

  for (const period of periods) {
    const day = dayOf(period.open);
    const open = hhmm(period.open);
    if (!day || !open) continue; // unparseable — never guess

    // Open 24 hours: an `open` with no `close` at all.
    if (!period.close) {
      byDay.set(day, [{ open: "00:00", close: "23:59" }]);
      continue;
    }

    const close = hhmm(period.close);
    const closeDay = dayOf(period.close);
    if (!close) continue;
    if (closeDay && closeDay !== day) {
      skip(day, "closes on a different day (overnight)");
      byDay.delete(day);
      continue;
    }
    if (close <= open) {
      skip(day, "closing time is not after opening time");
      byDay.delete(day);
      continue;
    }
    if (skipped.some((s) => s.day === day)) continue; // already disqualified

    byDay.set(day, [...(byDay.get(day) ?? []), { open, close }]);
  }

  const hours: BusinessHours = {};
  for (const day of HOUR_DAYS) {
    if (skipped.some((s) => s.day === day)) continue;
    const ranges = byDay.get(day);
    // Absent from the response = closed that day. Places says so by omission.
    if (!ranges || ranges.length === 0) {
      hours[day] = "closed";
      continue;
    }
    if (ranges.length > 2) {
      skip(day, "more than two opening blocks");
      continue;
    }
    const sorted = [...ranges].sort((a, b) => a.open.localeCompare(b.open));
    // Two blocks must not overlap; if they do we cannot say which is right.
    if (sorted.length === 2 && sorted[1].open <= sorted[0].close) {
      skip(day, "opening blocks overlap");
      continue;
    }
    hours[day] = sorted.map((r) => `${r.open}-${r.close}`).join(",");
  }

  return { hours: Object.keys(hours).length > 0 ? hours : null, skipped };
}
