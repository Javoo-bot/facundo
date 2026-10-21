/** Server-only Google Places (New) client, used by the public join form's
 * address autocomplete (app/api/places/*).
 *
 * SERVER ONLY. `GOOGLE_MAPS_API_KEY` is never `NEXT_PUBLIC_` and never reaches
 * the browser — the two route handlers proxy for it. Both routes gate on the
 * florist's join token, so this isn't an open relay to a billable API.
 *
 * One key for the whole Google Maps Platform account rather than a
 * Places-specific one: that is what the project already provisions, and the
 * Places API is enabled on it. Restrict it by API in the GCP console, not by
 * HTTP referrer — these calls originate from our server, so there is no
 * referrer to check.
 *
 * SESSION TOKENS. Google bills autocomplete per SESSION, not per keystroke,
 * but only when the caller threads one `sessionToken` through every
 * autocomplete call and the final details call. Dropping it turns a ~10
 * keystroke lookup into ~10 billable requests. The client mints the UUID and
 * passes it through; this module just forwards it.
 *
 * Never throws. Every failure — no key, non-2xx, malformed JSON, network —
 * degrades to an empty list or null, because a florist must always be able to
 * type their address by hand. */

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";

/** Below this, predictions are noise and we'd be paying for them. */
export const MIN_AUTOCOMPLETE_INPUT = 3;
/** Longest input we forward. Guards against someone pasting a novel through the proxy. */
export const MAX_AUTOCOMPLETE_INPUT = 200;

export interface PlaceSuggestion {
  placeId: string;
  /** The shop / street line — bold in the list. */
  primary: string;
  /** City, region, country — the disambiguating line. */
  secondary: string;
}

export interface PlaceLocation {
  address: string;
  lat: number;
  lng: number;
}

function apiKey(): string | null {
  return process.env.GOOGLE_MAPS_API_KEY?.trim() || null;
}

/** True when Places is configured. The routes report this so the client can
 * quietly fall back to a plain text input rather than showing a broken
 * autocomplete that never returns anything. */
export function placesConfigured(): boolean {
  return apiKey() !== null;
}

/** Address predictions for `input`, or an empty list.
 *
 * `regionCodes` biases to the country the florist was ingested under — a
 * two-character CLDR code (the same alpha-2 `lib/phone.ts::countryToRegion`
 * produces). Without it, a short street name matches half the planet. */
export async function autocompletePlaces(
  input: string,
  sessionToken: string,
  opts: { regionCode?: string | null; languageCode?: string | null } = {}
): Promise<PlaceSuggestion[]> {
  const key = apiKey();
  const trimmed = input.trim();
  if (!key || trimmed.length < MIN_AUTOCOMPLETE_INPUT) return [];

  try {
    const res = await fetch(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
      },
      body: JSON.stringify({
        input: trimmed.slice(0, MAX_AUTOCOMPLETE_INPUT),
        sessionToken,
        ...(opts.regionCode ? { includedRegionCodes: [opts.regionCode.toLowerCase()] } : {}),
        ...(opts.languageCode ? { languageCode: opts.languageCode } : {}),
      }),
    });
    if (!res.ok) {
      console.error("places/autocomplete: upstream", res.status, await res.text().catch(() => ""));
      return [];
    }
    const json = (await res.json()) as {
      suggestions?: {
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
        };
      }[];
    };
    return (json.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
      .map((p) => ({
        placeId: p.placeId as string,
        // structuredFormat is the two-line split; `text` is the whole thing.
        // Fall back to `text` so a prediction without the split still renders.
        primary: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        secondary: p.structuredFormat?.secondaryText?.text ?? "",
      }))
      .filter((s) => s.primary);
  } catch (e) {
    console.error("places/autocomplete: request failed", e);
    return [];
  }
}

/** The formatted address and coordinates for a place, or null.
 *
 * Passing the same `sessionToken` the autocomplete calls used is what CLOSES
 * the billing session — omitting it means every keystroke was billed
 * individually. The field mask is deliberately minimal: we are billed by
 * which fields we ask for, and we only store these two.
 *
 * Returns null unless BOTH a formatted address and finite coordinates came
 * back. A half-answer here would put a verified checkmark on the form next to
 * coordinates we don't actually have. */
export async function placeDetails(
  placeId: string,
  sessionToken: string,
  opts: { languageCode?: string | null } = {}
): Promise<PlaceLocation | null> {
  const key = apiKey();
  if (!key || !placeId.trim()) return null;

  try {
    const url = new URL(`${DETAILS_URL}/${encodeURIComponent(placeId.trim())}`);
    url.searchParams.set("sessionToken", sessionToken);
    if (opts.languageCode) url.searchParams.set("languageCode", opts.languageCode);

    const res = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "formattedAddress,location",
      },
    });
    if (!res.ok) {
      console.error("places/details: upstream", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as {
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    };
    const address = json.formattedAddress?.trim();
    const lat = json.location?.latitude;
    const lng = json.location?.longitude;
    if (!address || typeof lat !== "number" || typeof lng !== "number") return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { address, lat, lng };
  } catch (e) {
    console.error("places/details: request failed", e);
    return null;
  }
}

/** Everything the staff "add a florist by hand" dialog pre-fills from Maps.
 *
 * A SEPARATE call from `placeDetails` on purpose. That one asks for
 * `formattedAddress,location` and nothing else, because Places bills by which
 * fields you request and the public join form only ever stored those two —
 * widening it would raise the cost of every florist's address lookup to serve
 * a staff screen they never see. This one is called a handful of times a week,
 * by us, so the richer (and pricier) SKU is the right trade here and the wrong
 * one there. */
export interface PlaceRichDetails {
  /** The bare Google id, with the "places/" resource prefix stripped — the
   * form `florists.place_id` holds and the ingest dedups on. */
  placeId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  /** Raw Places periods; map with lib/placeHours.ts. */
  periods: unknown[] | null;
  rating: number | null;
  reviewCount: number | null;
}

interface PlaceDetailsResponse {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { periods?: unknown[] };
  rating?: number;
  userRatingCount?: number;
}

export async function placeDetailsRich(
  placeId: string,
  sessionToken: string,
  opts: { languageCode?: string | null } = {}
): Promise<PlaceRichDetails | null> {
  const key = apiKey();
  if (!key || !placeId.trim()) return null;

  try {
    const url = new URL(`${DETAILS_URL}/${encodeURIComponent(placeId.trim())}`);
    if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
    if (opts.languageCode) url.searchParams.set("languageCode", opts.languageCode);

    const res = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": [
          "id",
          "displayName",
          "formattedAddress",
          "location",
          "nationalPhoneNumber",
          "websiteUri",
          "regularOpeningHours",
          "rating",
          "userRatingCount",
        ].join(","),
      },
    });
    if (!res.ok) {
      console.error("places/details-rich: upstream", res.status, await res.text().catch(() => ""));
      return null;
    }
    const j = (await res.json()) as PlaceDetailsResponse;
    // A BUSINESS result carries displayName; a plain STREET ADDRESS often does
    // not. The off-maps path deliberately picks an address (the shop is
    // unlisted, the street is not), so falling back to the formatted address
    // is what keeps that path working — the caller overwrites `name` with the
    // typed shop name anyway. Only a result with neither is unusable.
    const name = j.displayName?.text?.trim() || j.formattedAddress?.trim();
    if (!name) return null;

    const lat = j.location?.latitude;
    const lng = j.location?.longitude;
    const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

    return {
      // Places (New) returns `id` bare, but the resource name form shows up in
      // some responses; strip it so we never store "places/ChIJ…" as a key the
      // ingest would then fail to match.
      placeId: String(j.id ?? placeId).replace(/^places\//, ""),
      name,
      address: j.formattedAddress?.trim() || null,
      lat: finite(lat),
      lng: finite(lng),
      phone: j.nationalPhoneNumber?.trim() || null,
      website: j.websiteUri?.trim() || null,
      periods: Array.isArray(j.regularOpeningHours?.periods) ? j.regularOpeningHours.periods : null,
      rating: finite(j.rating),
      reviewCount: finite(j.userRatingCount),
    };
  } catch (e) {
    console.error("places/details-rich: request failed", e);
    return null;
  }
}
