/** Create a florist we already work with by hand, and mint their join link.
 *
 * The I/O seam for lib/manualFlorist.ts — every decision that can be made
 * without a database is there and unit-tested; this route does the four things
 * that cannot be: the duplicate check, the city resolve/create, the insert, and
 * the token mint.
 *
 * Service-role, because it writes `florists` and possibly `cities` (neither has
 * an RLS insert policy for `authenticated` — same write posture as
 * app/api/ingest). Gated on a signed-in, allow-listed staff member first.
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAllowedUser, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { normalizePhone, countryToRegion } from "@/lib/phone";
import { regionToLocale } from "@/lib/i18n";
import { buildJoinUrl } from "@/lib/floristJoin";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { pickCity, buildManualFloristRow, validateManualFlorist, isManualPlaceId, type CityRow } from "@/lib/manualFlorist";

export const dynamic = "force-dynamic";

/** Hand-sent links get a SHORTER life than the 30 days a cold recruiting email
 * uses (lib/floristJoin.ts::JOIN_TOKEN_TTL_DAYS). A cold prospect may take
 * weeks to come back to us; a partner you are messaging on WhatsApp right now
 * will open it today. The link is a bearer credential — anyone holding it can
 * view and edit that shop's record — so the window should match the actual use.
 * Expiry is not a dead end: needsNewJoinToken re-mints cleanly. */
const HAND_SENT_TTL_DAYS = 7;

function handSentExpiry(now: Date): string {
  return new Date(now.getTime() + HAND_SENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export async function POST(req: Request) {
  const auth = await requireAllowedUser();
  if (!auth.ok) return auth.res;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const validated = validateManualFlorist({ ...body, added_by: auth.email });
  if (!validated.ok) return jsonError(validated.error, 400);
  const values = validated.values;

  const admin = createServiceClient();

  // 1. DUPLICATE GUARD — across ALL cities, not just the one we're about to
  //    file them under. `lib/lifecycle.ts` already documents "the same physical
  //    storefront exists as more than one florist row and gets offered twice on
  //    one order" as a live failure branch, and adding partners by hand is the
  //    most likely new cause of it: you add them today, we scrape their city in
  //    six weeks. Refusing here (and pointing at the existing record) is the
  //    single highest-value check in this route.
  const { data: existing, error: dupError } = await admin
    .from("florists")
    .select("id, name, city_id, deleted_at")
    .eq("place_id", values.place_id)
    .limit(1)
    .maybeSingle();
  if (dupError) {
    console.error("florists/create: duplicate check failed", dupError.message);
    return jsonError("Could not check for an existing florist. Nothing was created.", 500);
  }
  if (existing) {
    return NextResponse.json(
      {
        error: "duplicate",
        message: `${existing.name} is already in the system.`,
        floristId: existing.id,
        // A soft-deleted twin is worth saying out loud: the fix is to restore
        // that row, not to create a second one that will collide on re-ingest.
        deleted: !!existing.deleted_at,
      },
      { status: 409 }
    );
  }

  // 1b. NAME GUARD, for off-maps shops only. The place_id check above is the
  //     real dedup, but a synthesised key cannot collide with anything — so for
  //     exactly the population that needs it most, that protection evaporates.
  //     "Not on Google Maps" often means "I couldn't find them", and the shop
  //     may already be in the roster under a slightly different spelling. A
  //     case-insensitive name match is coarse, but it catches the honest
  //     mistake, and it warns rather than blocks so a genuine second branch on
  //     another street can still be added.
  let nameWarning: string | null = null;
  if (isManualPlaceId(values.place_id)) {
    const { data: sameName } = await admin
      .from("florists")
      .select("id, name, address")
      .ilike("name", values.name)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (sameName && body.confirm_duplicate_name !== true) {
      return NextResponse.json(
        {
          error: "possible-duplicate",
          message: `A florist called "${sameName.name}" already exists${sameName.address ? ` at ${sameName.address}` : ""}. Add anyway only if this is a different shop.`,
          floristId: sameName.id,
          confirmable: true,
        },
        { status: 409 }
      );
    }
    if (sameName) nameWarning = `Created despite an existing florist named "${sameName.name}".`;
  }

  // 2. CITY — an existing one when the shop falls inside its own ingest radius
  //    (see pickCity), otherwise a new row marked `source = 'manual'` so the
  //    overview stops claiming a scrape that never happened.
  const { data: cities, error: cityError } = await admin
    .from("cities")
    .select("id, country, city, center_lat, center_lng, radius_km");
  if (cityError) {
    console.error("florists/create: city load failed", cityError.message);
    return jsonError("Could not load cities. Nothing was created.", 500);
  }

  let city = pickCity({ lat: values.lat, lng: values.lng }, (cities ?? []) as CityRow[]);
  let cityCreated = false;

  if (!city) {
    const country = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
    const cityName = typeof body.city_name === "string" ? body.city_name.trim() : "";
    if (!country || !cityName) {
      return jsonError(
        "No existing city covers this shop, so a country and city name are needed to file it under.",
        400
      );
    }
    const { data: created, error: insertCityError } = await admin
      .from("cities")
      .insert({
        country,
        city: cityName,
        center_lat: values.lat,
        center_lng: values.lng,
        // Deliberately null: no scrape has happened here, and radius_km means
        // "the radius the latest ingest searched".
        radius_km: null,
        source: "manual",
      })
      .select("id, country, city, center_lat, center_lng, radius_km")
      .single();
    if (insertCityError || !created) {
      console.error("florists/create: city insert failed", insertCityError?.message);
      return jsonError("Could not create a city for this shop. Nothing was created.", 500);
    }
    city = created as CityRow;
    cityCreated = true;
  }

  // 3. INSERT. Phones go through the SAME normalization the ingest row builder
  //    applies, so a hand-added row is indistinguishable from a scraped one —
  //    the whole premise of lib/manualFlorist.ts.
  const region = countryToRegion(city.country);
  const now = new Date();
  const token = randomUUID();

  // Stamped at creation, mirroring what the ingest's fill_null_locales does
  // for scraped florists. Without it every hand-added shop carries a null
  // locale, and each caller has to remember to derive one from the country.
  const row = {
    locale: regionToLocale(city.country),
    ...buildManualFloristRow(
      {
        ...values,
        phone_web: values.phone_web ? (normalizePhone(values.phone_web, region) as string) : null,
        phone_mobile: values.phone_mobile ? (normalizePhone(values.phone_mobile, region) as string) : null,
      },
      city.id
    ),
    join_token: token,
    join_token_expires_at: handSentExpiry(now),
  };

  const { data: florist, error: insertError } = await admin
    .from("florists")
    .insert(row)
    .select("id, name")
    .single();
  if (insertError || !florist) {
    console.error("florists/create: insert failed", insertError?.message);
    return jsonError(insertError?.message ?? "Could not create the florist.", 500);
  }

  // The link is built on the FLORIST host, never the request's own origin.
  // Staff create these from the backoffice, so `req.url` would have handed the
  // florist a bo.* link — a host their session cannot even serve the join form
  // from. FLORIST_BASE is the same constant the outbound emails use, so every
  // join link we send points at one place.
  return NextResponse.json({
    floristId: florist.id,
    name: florist.name,
    joinUrl: buildJoinUrl(FLORIST_BASE, token),
    offMaps: isManualPlaceId(values.place_id),
    nameWarning,
    expiresAt: row.join_token_expires_at,
    city: { id: city.id, name: city.city, country: city.country, created: cityCreated },
  });
}
