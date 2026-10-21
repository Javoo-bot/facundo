/** Places lookup for the staff "add a florist by hand" dialog.
 *
 * A SEPARATE route from /api/places/autocomplete and /api/places/details, which
 * gate on a florist's join token (lib/joinTokenGate.ts). Those exist so a public,
 * unauthenticated form can spend our billable Places quota without becoming an
 * open relay. This caller is a signed-in staff member and has no join token —
 * and loosening that gate to let them through would weaken a deliberately
 * fail-closed check for every public visitor too. So: same underlying client,
 * different door, staff auth instead. */

import { NextResponse } from "next/server";
import { requireAllowedUser, jsonError } from "@/lib/apiAuth";
import { autocompletePlaces, placeDetailsRich, placesConfigured } from "@/lib/places";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAllowedUser();
  if (!auth.ok) return auth.res;

  if (!placesConfigured()) {
    return NextResponse.json({ configured: false, suggestions: [], place: null });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken : "";

  if (body.action === "search") {
    const input = typeof body.input === "string" ? body.input : "";
    const suggestions = await autocompletePlaces(input, sessionToken, {
      // Staff search by shop name across whichever country they're recruiting
      // in, so unlike the join form there is no florist to bias towards.
      regionCode: typeof body.regionCode === "string" ? body.regionCode : null,
    });
    return NextResponse.json({ configured: true, suggestions });
  }

  if (body.action === "details") {
    const placeId = typeof body.placeId === "string" ? body.placeId : "";
    const place = await placeDetailsRich(placeId, sessionToken);
    return NextResponse.json({ configured: true, place });
  }

  return jsonError('action must be "search" or "details".', 400);
}
