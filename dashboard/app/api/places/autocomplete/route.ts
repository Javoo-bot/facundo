import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { floristForJoinToken } from "@/lib/joinTokenGate";
import { autocompletePlaces, placesConfigured, MIN_AUTOCOMPLETE_INPUT } from "@/lib/places";
import { countryToRegion } from "@/lib/phone";
import { resolveFloristLocale } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Address predictions for the public join form. Unauthenticated in the same
 * sense as app/api/florist/accept — a live join token is the credential — but
 * unlike that route this one spends money upstream, so the gate is the whole
 * point. See lib/joinTokenGate.ts. */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const input = typeof body.input === "string" ? body.input : "";
  const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken.trim() : "";
  if (!sessionToken) return jsonError("sessionToken is required.", 400);

  // Short inputs never reach Google — they'd be noise we pay for.
  if (input.trim().length < MIN_AUTOCOMPLETE_INPUT) {
    return Response.json({ suggestions: [], configured: placesConfigured() });
  }

  const admin = createServiceClient();
  const florist = await floristForJoinToken(admin, body.token);
  if (!florist) return jsonError("Link not found.", 404);

  // Bias to the country the florist was ingested under. Without it a short
  // street name matches half the planet and the first page is useless.
  let regionCode: string | null = null;
  if (florist.city_id) {
    const { data: city } = await admin.from("cities").select("country").eq("id", florist.city_id).maybeSingle();
    regionCode = countryToRegion(city?.country ?? null);
  }

  const suggestions = await autocompletePlaces(input, sessionToken, {
    regionCode,
    languageCode: resolveFloristLocale({ locale: florist.locale }),
  });

  return Response.json({ suggestions, configured: placesConfigured() });
}
