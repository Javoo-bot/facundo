import { cookies, headers } from "next/headers";
import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { VIEW_AS_COOKIE, VIEW_AS_TTL_MS, newClaim, encodeClaim } from "@/lib/viewAs";
import { sharedCookieDomain } from "@/lib/hostRouting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enter "view as florist": mints the signed, HttpOnly view-as cookie for the
 * calling staff user. Read-only by construction — the cookie never grants write
 * ability (see lib/viewAs.ts). Only ops/admin may impersonate.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let b: { floristId?: unknown };
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const floristId = typeof b.floristId === "string" ? b.floristId.trim() : "";
  if (!floristId) return jsonError("floristId must be a non-empty string.", 400);

  // Confirm the florist exists (and isn't hard-deleted) before minting a cookie.
  const admin = createServiceClient();
  const { data: florist, error } = await admin
    .from("florists")
    .select("id, name")
    .eq("id", floristId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return jsonError(`Failed to load florist: ${error.message}`, 500);
  if (!florist) return jsonError("Florist not found.", 404);

  const token = encodeClaim(newClaim(floristId, gate.email));
  const jar = await cookies();
  const host = (await headers()).get("host");
  jar.set(VIEW_AS_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(VIEW_AS_TTL_MS / 1000),
    domain: sharedCookieDomain(host),
  });

  return Response.json({ ok: true, floristName: florist.name ?? null });
}

/** Exit view-as: clear the cookie. */
export async function DELETE(): Promise<Response> {
  const jar = await cookies();
  const host = (await headers()).get("host");
  // Must match the domain it was set with, or the browser keeps the original
  // cookie around alongside this no-op deletion.
  jar.delete({ name: VIEW_AS_COOKIE, path: "/", domain: sharedCookieDomain(host) });
  return Response.json({ ok: true });
}
