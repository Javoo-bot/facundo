// Florist-local time. Relative imports only (no "@/..."), so plain `node --test`
// can reach it — same constraint as lib/offerEmailContent.ts.
//
// Why this exists: the offer email now names an absolute deadline ("we need your
// answer before 18:30") instead of a countdown. An absolute time is only correct
// in the READER's timezone, and we don't store one — we store the shop's
// lat/lng. `tz-lookup` turns those into an IANA zone offline (no API, no
// network), including the cases a country->zone map gets wrong: Atlantic/Azores
// and Atlantic/Canary, and Brazil's four zones.
//
// Everything here degrades to null rather than guessing. A florist with no
// coordinates gets the relative countdown instead — see
// lib/offerEmailContent.ts, which picks the sentence based on what this returns.
import tzLookup from "tz-lookup";
import type { Locale } from "./i18n/index.ts";

/** `en` resolves through en-GB deliberately: bare "en" is en-US, which renders
 * 12-hour AM/PM and month-first dates. Every florist-facing time in this
 * product is day-first + 24h. Mirrors lib/offerEmailContent.ts's identical
 * choice in formatOfferDeliverBy. */
function intlLocale(locale: Locale): string {
  return locale === "en" ? "en-GB" : locale;
}

/** IANA zone for a shop's coordinates, or null when we don't have usable ones.
 * Null is a real and expected state — florists ingested without a geocode, or
 * from a source that didn't carry lat/lng. Never throws: tz-lookup rejects
 * out-of-range coordinates, and a bad row must not take down a send. */
export function floristTimeZone(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  try {
    return tzLookup(lat, lng);
  } catch {
    return null;
  }
}

/** The calendar date at `ms` in `tz`, as "YYYY-MM-DD". en-CA gives ISO order,
 * which makes the same-day comparison a plain string equality. */
function localDate(ms: number, tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return null; // unknown zone — caller falls back to the countdown
  }
}

/** The offer deadline as a florist-local wall-clock string, or null when we
 * can't state one honestly. Null means "use the relative countdown instead",
 * and happens when:
 *   - we have no timezone (no coordinates), or the zone is unknown to Intl;
 *   - the expiry is missing or unparseable;
 *   - the deadline has already PASSED. "answer before 14:30" at 15:10 reads as
 *     broken, and this is a live path: late accepts are allowed
 *     (lib/lateAccept.ts) and previews re-render old assignments.
 *
 * Same-day deadlines render as time only ("18:30"). A deadline that lands on a
 * different local day carries the date too ("6 Aug, 09:15") — the offer window
 * is configurable per order class (settings.offer_window_*), so it can and does
 * cross midnight, and a bare "09:15" would be ambiguous exactly when the
 * florist has the most time to act.
 *
 * `nowMs` is injectable for tests. */
export function formatOfferDeadline(
  locale: Locale,
  expiresAtIso: string | null | undefined,
  tz: string | null,
  nowMs: number = Date.now()
): string | null {
  if (!tz || !expiresAtIso) return null;
  const d = new Date(expiresAtIso);
  const ms = d.getTime();
  if (!Number.isFinite(ms) || ms <= nowMs) return null;

  const today = localDate(nowMs, tz);
  const deadlineDay = localDate(ms, tz);
  if (today === null || deadlineDay === null) return null;

  try {
    return deadlineDay === today
      ? d.toLocaleTimeString(intlLocale(locale), {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
      : d.toLocaleString(intlLocale(locale), {
          timeZone: tz,
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
  } catch {
    return null;
  }
}
