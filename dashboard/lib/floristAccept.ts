/** Validates the public "join our network" self-registration submission
 * (dashboard/app/api/florist/accept). Untrusted, unauthenticated input — token
 * possession is the route's only gate — so this is stricter about shape than
 * lib/floristDetails.ts (the staff-only equivalent).
 *
 * Relative imports only (no "@/..."), so plain `node --test` can reach it. */

import { normalizePhone } from "./phone.ts";

export const HOUR_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type HourDay = (typeof HOUR_DAYS)[number];
export type BusinessHours = Partial<Record<HourDay, string>>;

export const CUTOFF_HOURS = [11, 12, 13, 14, 15] as const;
export type CutoffHour = (typeof CUTOFF_HOURS)[number];

/** Long enough for a real paragraph about the shop, short enough that nobody
 * pastes their whole website through the public endpoint. Mirrored in the
 * form's character counter. */
export const SHOP_STORY_MAX = 600;

/** Mirrors lib/i18n/locales.ts::LOCALES. Duplicated rather than imported so
 * this module keeps its "relative imports only" property and stays loadable by
 * plain `node --test`; the i18n barrel pulls in the whole catalog. */
export const SUPPORTED_LOCALES = ["en", "fr", "es", "it", "de", "pt"];

/** The person's name, not the shop's. Generous but bounded — long enough for
 * "María del Carmen Fernández-Aguilar", short enough that the public endpoint
 * can't be used to store prose. */
export const OWNER_NAME_MAX = 80;

export interface AcceptValues {
  /** The language the florist chose while filling the form in, or null if they
   * left it as we defaulted it. Written to `florists.locale`, which is what
   * every later email and SMS reads: picking a language here is telling us how
   * to write to you from now on, not just how to read this page. */
  locale: string | null;
  name: string;
  /** Optional. Null means "they left it blank", which buildAcceptUpdate turns
   * into an omitted key rather than a null write — the ingest may already have
   * extracted a real owner name we must not erase. */
  owner_name: string | null;
  address: string | null;
  phone: string | null;
  phone_mobile: string | null;
  email: string | null;
  shop_story: string | null;
  business_hours: BusinessHours | null;
  next_day_cutoff_hour: CutoffHour;
  /** Set only when the florist picked a Google Places suggestion. Null means
   * "they typed it by hand", which must LEAVE the stored coordinates alone —
   * see buildAcceptUpdate. */
  lat: number | null;
  lng: number | null;
}

// Mirrors the permissive, unicode-tolerant pattern used across the dashboard
// (e.g. lib/offerVars.ts, lib/floristDetails.ts).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TIME_RANGE_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** One or TWO ranges — "09:00-19:00", or "09:00-13:00,16:00-20:00" for a shop
 * with a midday closure. The two-block form is the normal shape of a florist's
 * day in ES/FR/IT/PT; see the `open2` note in lib/businessHours.ts.
 *
 * Each block must close after it opens, and the second must start after the
 * first ends — otherwise the pair describes an overlap rather than a break, and
 * we could not say when the shop is actually shut. */
function isValidRange(value: string): boolean {
  const parts = value.split(",");
  if (parts.length > 2) return false;

  let previousClose = -1;
  for (const part of parts) {
    const m = part.trim().match(TIME_RANGE_RE);
    if (!m) return false;
    const openMinutes = Number(m[1]) * 60 + Number(m[2]);
    const closeMinutes = Number(m[3]) * 60 + Number(m[4]);
    if (closeMinutes <= openMinutes) return false;
    if (openMinutes <= previousClose) return false;
    previousClose = closeMinutes;
  }
  return true;
}

function validateBusinessHours(
  raw: unknown
): { ok: true; value: BusinessHours | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "business_hours must be an object or null." };
  }
  const value: BusinessHours = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(HOUR_DAYS as readonly string[]).includes(key)) {
      return { ok: false, error: `business_hours has an unrecognized day key: "${key}".` };
    }
    if (typeof v !== "string") {
      return { ok: false, error: `business_hours.${key} must be a string.` };
    }
    if (v !== "closed" && !isValidRange(v)) {
      return {
        ok: false,
        error: `business_hours.${key} must be "closed", "HH:MM-HH:MM", or two non-overlapping blocks "HH:MM-HH:MM,HH:MM-HH:MM", with each close after its open.`,
      };
    }
    value[key as HourDay] = v;
  }
  return { ok: true, value: Object.keys(value).length > 0 ? value : null };
}

/** Coordinates from a Google Places pick, or null when none was made.
 *
 * All-or-nothing: one coordinate without the other is a bug on our side, and
 * half a position is worse than none — it would put a shop on the equator or
 * the prime meridian. Rejected rather than silently dropped so we find out. */
function validateCoords(
  rawLat: unknown,
  rawLng: unknown
): { ok: true; lat: number | null; lng: number | null } | { ok: false; error: string } {
  const missing = (v: unknown) => v === null || v === undefined;
  if (missing(rawLat) && missing(rawLng)) return { ok: true, lat: null, lng: null };
  if (missing(rawLat) || missing(rawLng)) {
    return { ok: false, error: "lat and lng must be provided together." };
  }
  if (typeof rawLat !== "number" || typeof rawLng !== "number") {
    return { ok: false, error: "lat and lng must be numbers." };
  }
  if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng)) {
    return { ok: false, error: "lat and lng must be finite." };
  }
  if (rawLat < -90 || rawLat > 90 || rawLng < -180 || rawLng > 180) {
    return { ok: false, error: "lat and lng must be within valid coordinate ranges." };
  }
  return { ok: true, lat: rawLat, lng: rawLng };
}

/** `defaultRegion` is the ISO-3166-1 alpha-2 country of the city this florist
 * was ingested under (lib/phone.ts::countryToRegion). It lets a florist type a
 * national number — "612 34 56 78" — instead of forcing "+34…". Null still
 * works for numbers already in international form. */
export function validateAcceptSubmission(
  body: Record<string, unknown>,
  defaultRegion: string | null = null
): { ok: true; values: AcceptValues } | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "name must be a non-empty string." };

  const rawLocale = typeof body.locale === "string" ? body.locale.trim() : "";
  if (rawLocale && !SUPPORTED_LOCALES.includes(rawLocale)) {
    return { ok: false, error: "locale must be one of the supported languages." };
  }
  const locale = rawLocale || null;

  const rawOwner = typeof body.owner_name === "string" ? body.owner_name.trim() : "";
  if (rawOwner.length > OWNER_NAME_MAX) {
    return { ok: false, error: `owner_name must be ${OWNER_NAME_MAX} characters or fewer.` };
  }
  const owner_name = rawOwner || null;

  const address = typeof body.address === "string" ? body.address.trim() || null : null;
  const phone = typeof body.phone === "string" ? body.phone.trim() || null : null;

  // OPTIONAL, but validated when given. A florist with only a landline should
  // still be able to join — email and push carry the offer, and the matcher
  // treats a missing SMS number as a skipped leg, not a blocked order
  // (lib/reachoutSend.ts). What we will NOT do is store something unsendable:
  // a number we can't text looks like a working notification channel and
  // silently isn't, which is worse for the florist than being told now.
  const rawMobile = typeof body.phone_mobile === "string" ? body.phone_mobile.trim() : "";
  let phone_mobile: string | null = null;
  if (rawMobile) {
    phone_mobile = normalizePhone(rawMobile, defaultRegion);
    if (!phone_mobile) {
      return { ok: false, error: "phone_mobile must be a phone number we can send messages to." };
    }
  }

  const rawEmail = typeof body.email === "string" ? body.email.trim() : "";
  if (rawEmail && !EMAIL_RE.test(rawEmail)) {
    return { ok: false, error: "email must be a valid email address." };
  }
  const email = rawEmail || null;

  const rawStory = typeof body.shop_story === "string" ? body.shop_story.trim() : "";
  if (rawStory.length > SHOP_STORY_MAX) {
    return { ok: false, error: `shop_story must be ${SHOP_STORY_MAX} characters or fewer.` };
  }
  const shop_story = rawStory || null;

  const hoursResult = validateBusinessHours(body.business_hours);
  if (!hoursResult.ok) return hoursResult;

  const coords = validateCoords(body.lat, body.lng);
  if (!coords.ok) return coords;

  const cutoff = body.next_day_cutoff_hour;
  if (!(CUTOFF_HOURS as readonly number[]).includes(cutoff as number)) {
    return { ok: false, error: "next_day_cutoff_hour must be one of 11, 12, 13, 14, 15." };
  }

  return {
    ok: true,
    values: {
      locale,
      name,
      owner_name,
      address,
      phone,
      phone_mobile,
      email,
      shop_story,
      business_hours: hoursResult.value,
      next_day_cutoff_hour: cutoff as CutoffHour,
      lat: coords.lat,
      lng: coords.lng,
    },
  };
}

/** Builds the `florists` update row for a self-registration submission.
 *
 * Four keys are OMITTED rather than set to null when the submission has
 * nothing for them — the same "absent from the update ≠ null it out"
 * convention as lib/floristDetails.ts / app/api/florists/operational/route.ts:
 *
 * - `owner_name`, when the florist left it blank. The ingest extracts owner
 *   names from shop websites (ingest/usage.py::MODEL_FOR_CALL), so the column
 *   is often already populated with something real; an optional field left
 *   empty is not an instruction to forget who we're talking to.
 *
 * - `phone_mobile`, when the florist left it blank. It is optional, and staff
 *   may have already entered a good number on the florist card; a blank field
 *   on a form that never showed them that number is not an instruction to
 *   delete it.
 *
 * - `business_hours`, when the grid produced nothing. Real staff-entered hours
 *   use a grouped-day convention (`{"mon_fri":"09:00-20:00"}` — see
 *   supabase/seed/2026-07-13-florist-demo.sql and lib/businessHours.ts), and
 *   clobbering that with null would destroy real data.
 *
 * - `lat`/`lng`, when the florist typed their address instead of picking a
 *   Google Places suggestion. The ingest already geocoded them; a hand-typed
 *   address is not a reason to forget where the shop is. It does mean the
 *   stored coordinates can now disagree with the stored address text — that is
 *   the deliberate trade, since coordinates drive matching and distance while
 *   the text is only ever displayed.
 *
 * `place_id` is never written: it is the Apify dedup key under
 * `unique (city_id, place_id)`, and overwriting it with a Google Places ID
 * risks colliding with another row and breaking ingest idempotency. */
export function buildAcceptUpdate(
  values: AcceptValues,
  joinedAtIso: string,
  /** When the florist joined the FIRST time, if they already had. Re-running
   * the form is editing your details, not joining again — restamping this
   * would erase how long they have actually been with us, which the greeting,
   * the roster and their standing all read. */
  existingJoinedAt: string | null = null
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    name: values.name,
    address: values.address,
    phone_web: values.phone,
    email: values.email,
    shop_story: values.shop_story,
    next_day_cutoff_hour: values.next_day_cutoff_hour,
    joined_at: existingJoinedAt ?? joinedAtIso,
  };
  // Omitted when they never touched the picker, so the form cannot overwrite a
  // locale staff set deliberately with the one we happened to default to.
  if (values.locale !== null) update.locale = values.locale;
  if (values.owner_name !== null) update.owner_name = values.owner_name;
  if (values.phone_mobile !== null) update.phone_mobile = values.phone_mobile;
  if (values.business_hours !== null) update.business_hours = values.business_hours;
  if (values.lat !== null && values.lng !== null) {
    update.lat = values.lat;
    update.lng = values.lng;
  }
  return update;
}
