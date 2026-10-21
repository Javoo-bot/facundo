import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient } from "./supabase";
import { isAllowed, getStaffRole } from "./allowlist";
import { encodeClaim as encode, decodeClaim as decode, type ViewAsClaim } from "./viewAsToken";

/**
 * "View as florist" — lets an allow-listed staff member view the florist-facing
 * app exactly as a chosen florist sees it, to guide/support them. READ-ONLY by
 * construction: this module never consults `florist_users`, so it can grant no
 * write ability. Florist write routes authorize via `currentFlorist()` (which a
 * staff JWT resolves to null → 401), and that path is deliberately untouched.
 *
 * The mechanism is a short-lived, HMAC-signed, HttpOnly cookie carrying the
 * target florist id + the staff email it was minted for. The cookie alone is
 * never trusted — every read re-verifies the live session is an allow-listed,
 * impersonation-capable staff user whose email matches the cookie (so a stale
 * cookie can't be replayed by a different session, and a non-staff user who
 * somehow holds the cookie is ignored).
 */

export const VIEW_AS_COOKIE = "fc_viewas";
const TTL_MS = 30 * 60 * 1000; // 30 minutes
/** Roles permitted to view as a florist (support-facing). */
const ROLES_ALLOWED = new Set(["ops", "admin"]);

function secret(): string {
  // Reuse the server-only service-role key as the signing secret (never shipped
  // to the client) unless a dedicated VIEW_AS_SECRET is configured.
  const s = process.env.VIEW_AS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("view-as signing secret not configured");
  return s;
}

export function newClaim(floristId: string, staffEmail: string): ViewAsClaim {
  return { floristId, staffEmail: staffEmail.toLowerCase(), exp: Date.now() + TTL_MS };
}

export function encodeClaim(claim: ViewAsClaim): string {
  return encode(claim, secret());
}

export const VIEW_AS_TTL_MS = TTL_MS;

/**
 * Resolve an active, fully-verified staff view-as session, or null when there
 * is no valid impersonation. Cached per request. Callers that need the target
 * florist's data must read it via the service-role client (RLS won't surface it
 * to a staff JWT) — see lib/floristView.ts.
 */
export const resolveViewAs = cache(async (): Promise<{ floristId: string; staffEmail: string } | null> => {
  const jar = await cookies();
  const raw = jar.get(VIEW_AS_COOKIE)?.value;
  if (!raw) return null;

  const claim = decode(raw, secret());
  if (!claim || claim.exp < Date.now()) return null;

  // Re-verify the LIVE session — the signed cookie is necessary but not
  // sufficient. It must belong to the same allow-listed staff user, with an
  // impersonation-capable role.
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const email = user?.email;
  if (!email || email.toLowerCase() !== claim.staffEmail) return null;
  if (!(await isAllowed(email))) return null;
  const role = await getStaffRole(email);
  if (!role || !ROLES_ALLOWED.has(role)) return null;

  return { floristId: claim.floristId, staffEmail: email };
});

/** True if `role` may enter view-as (used by the entry API route). */
export function canViewAs(role: string | null | undefined): boolean {
  return !!role && ROLES_ALLOWED.has(role);
}
