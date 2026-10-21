/** Is this join token still good enough to act on?
 *
 * The join form is public — token possession is the only credential, the same
 * model as app/api/florist/unsubscribe. That's fine for the form itself, but
 * the address autocomplete it needs is a proxy to a BILLABLE Google API, and an
 * ungated proxy on the public internet is somebody else's free Places quota.
 * So both /api/places routes run this first: only a browser holding a live,
 * unredeemed join link can spend our key.
 *
 * Redeemability here matches app/api/florist/accept's own checks — not joined,
 * not expired — so the autocomplete stops working at exactly the moment the
 * form it serves stops working. */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface JoinTokenFlorist {
  id: string;
  lat: number | null;
  lng: number | null;
  locale: string | null;
  city_id: string | null;
}

/** The florist this token belongs to, or null when it is unknown, expired, or
 * already redeemed. Errors resolve to null — fail closed, like
 * lib/allowlist.ts::isAllowed. */
export async function floristForJoinToken(
  admin: SupabaseClient,
  token: unknown,
  nowMs: number = Date.now()
): Promise<JoinTokenFlorist | null> {
  if (typeof token !== "string" || !token.trim()) return null;

  const { data, error } = await admin
    .from("florists")
    .select("id, lat, lng, locale, city_id, join_token_expires_at, joined_at")
    .eq("join_token", token.trim())
    .maybeSingle();

  if (error) {
    console.error("joinTokenGate: lookup failed", error.message);
    return null;
  }
  if (!data) return null;
  // Deliberately NOT gated on joined_at any more: the join form can be re-run
  // to correct details, and an autocomplete that stopped working the moment
  // someone joined would break the address field on exactly that path.
  if (data.join_token_expires_at && new Date(data.join_token_expires_at).getTime() <= nowMs) return null;

  return { id: data.id, lat: data.lat, lng: data.lng, locale: data.locale, city_id: data.city_id };
}
