/** The join link for a florist who already exists, so staff can send it again.
 *
 * Until now a join URL could only be COPIED in the moment a florist was created
 * (components/florists/AddFloristDialog). Everywhere else it was minted
 * server-side and buried inside an email body — draft-email bakes it into the
 * draft, outreach/send and sequences/tick use it to send. So the ordinary case,
 * "I added this shop last week and now I want to send them the link", had no
 * answer at all.
 *
 * Mint-or-reuse, not always-mint: `needsNewJoinToken` already encodes the rule
 * (none yet, or expired) and draft-email already follows it. Minting on every
 * copy would silently invalidate a link the florist may already be looking at.
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAllowedUser, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { needsNewJoinToken, joinTokenExpiry, buildJoinUrl } from "@/lib/floristJoin";
import { FLORIST_BASE } from "@/lib/emailLinks";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAllowedUser();
  if (!auth.ok) return auth.res;

  let body: { floristId?: unknown };
  try {
    body = (await req.json()) as { floristId?: unknown };
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }
  const floristId = typeof body.floristId === "string" ? body.floristId.trim() : "";
  if (!floristId) return jsonError("floristId is required.", 400);

  const admin = createServiceClient();
  const { data: florist, error } = await admin
    .from("florists")
    .select("id, name, join_token, join_token_expires_at, joined_at, deleted_at")
    .eq("id", floristId)
    .maybeSingle();
  if (error) {
    console.error("florists/join-link: lookup failed", error.message);
    return jsonError("Could not load that florist.", 500);
  }
  if (!florist || florist.deleted_at) return jsonError("Florist not found.", 404);

  const now = new Date();
  let token = florist.join_token;
  let expiresAt = florist.join_token_expires_at;
  let minted = false;

  if (needsNewJoinToken(florist, now)) {
    token = randomUUID();
    expiresAt = joinTokenExpiry(now);
    const { error: writeError } = await admin
      .from("florists")
      .update({ join_token: token, join_token_expires_at: expiresAt })
      .eq("id", florist.id);
    if (writeError) {
      console.error("florists/join-link: token write failed", writeError.message);
      return jsonError("Could not create a link for that florist.", 500);
    }
    minted = true;
  }

  // `needsNewJoinToken` returns false for a florist who has already joined, so
  // one who joined before ever being given a token has none to hand out. Say
  // that plainly rather than returning a link built on a null.
  if (!token) {
    return NextResponse.json(
      { error: "no-token", message: `${florist.name} has already joined and has no active link.`, joined: true },
      { status: 409 }
    );
  }

  return NextResponse.json({
    // Always the florist host, never the caller's origin: staff copy this from
    // the backoffice, and a bo.* link is one the florist cannot even open.
    joinUrl: buildJoinUrl(FLORIST_BASE, token),
    expiresAt,
    minted,
    // Surfaced so the UI can warn: today a joined florist opening their link is
    // told they are already in the network rather than shown the form.
    joined: !!florist.joined_at,
    name: florist.name,
  });
}
