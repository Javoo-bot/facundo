import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { buildProvisionalActivation, type ProvisionalSource } from "@/lib/coldOffer";
import { stopAllForFlorist } from "@/lib/sequences/enrol";

type Admin = ReturnType<typeof createServiceClient>;

/**
 * A shop outside the network just accepted a real order, through a cold offer
 * or a staff manual assign. Mint the provisional activation that makes them a
 * florist. `source` only changes what `provisional_source` records.
 *
 * MUST run BEFORE payoutOnAccept: the payout reads `florists.trust_tier` to
 * pick the split, and a null tier there is the difference between paying 70%
 * and failing the leg outright.
 *
 * Idempotent and non-destructive:
 *  - CAS on `provisional_activated_at is null`, so a double-submitted accept
 *    mints once.
 *  - Radius and tier are only written when they are currently NULL. A shop that
 *    somehow already has a real tier keeps it — this must never DOWNGRADE a
 *    florist to provisional.
 *
 * Never throws: it is called from inside an accept that has already committed,
 * and failing it must not tell the florist their acceptance didn't work.
 */
export async function mintProvisionalActivation(
  admin: Admin,
  floristId: string,
  source: ProvisionalSource
): Promise<{ minted: boolean; reason?: string }> {
  try {
    const { data: settings } = await admin
      .from("app_settings")
      .select("cold_offer_default_radius_km")
      .eq("id", 1)
      .single();

    const { data: florist } = await admin
      .from("florists")
      .select("id, trust_tier, delivery_radius_km, joined_at, lifecycle_stage, provisional_activated_at")
      .eq("id", floristId)
      .single();
    if (!florist) return { minted: false, reason: "florist-not-found" };
    if (florist.provisional_activated_at) return { minted: false, reason: "already-provisional" };

    const nowIso = new Date().toISOString();
    const a = buildProvisionalActivation(settings, nowIso, source);

    // Only fill in what is missing. `production` is never overwritten — that
    // stage means a human vetted this shop, and nothing here has.
    const patch: Record<string, unknown> = {
      provisional_activated_at: a.provisional_activated_at,
      provisional_source: a.provisional_source,
    };
    if (florist.trust_tier == null) patch.trust_tier = a.trust_tier;
    if (florist.delivery_radius_km == null) patch.delivery_radius_km = a.delivery_radius_km;
    if (!florist.joined_at) patch.joined_at = a.joined_at;
    if (florist.lifecycle_stage !== "production") patch.lifecycle_stage = a.lifecycle_stage;

    const { data: won, error } = await admin
      .from("florists")
      .update(patch)
      .eq("id", floristId)
      .is("provisional_activated_at", null) // CAS: mint exactly once
      .select("id");
    if (error) {
      captureError("coldOffer.mintProvisional", error);
      return { minted: false, reason: error.message };
    }
    if (!won?.length) return { minted: false, reason: "raced" };

    // They are in the network now, by the strongest possible signal — they took
    // an order. Every recruiting pitch aimed at them is obsolete.
    await stopAllForFlorist(admin, floristId, "joined");

    return { minted: true };
  } catch (e) {
    captureError("coldOffer.mintProvisional", e);
    return { minted: false, reason: e instanceof Error ? e.message : "unknown" };
  }
}
