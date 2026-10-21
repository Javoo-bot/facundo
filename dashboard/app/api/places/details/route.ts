import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { floristForJoinToken } from "@/lib/joinTokenGate";
import { placeDetails } from "@/lib/places";
import { resolveFloristLocale } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resolves a picked prediction to a formatted address plus coordinates, and
 * closes the Places billing session. Same join-token gate as the autocomplete
 * route — see lib/joinTokenGate.ts. */
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const placeId = typeof body.placeId === "string" ? body.placeId.trim() : "";
  const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken.trim() : "";
  if (!placeId) return jsonError("placeId is required.", 400);
  if (!sessionToken) return jsonError("sessionToken is required.", 400);

  const admin = createServiceClient();
  const florist = await floristForJoinToken(admin, body.token);
  if (!florist) return jsonError("Link not found.", 404);

  const place = await placeDetails(placeId, sessionToken, {
    languageCode: resolveFloristLocale({ locale: florist.locale }),
  });
  // Null means we got a partial or failed answer. 502 rather than 200-with-null
  // so the client can tell "Google didn't answer" from "you picked nothing" —
  // it drops the verified badge either way and lets the typed text stand.
  if (!place) return jsonError("Could not resolve that address.", 502);

  return Response.json(place);
}
