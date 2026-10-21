import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isLocale } from "@/lib/i18n";
import { resendFloristNumberForActiveOrders } from "@/lib/shopifyWriteback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIER_CODES = ["1", "2", "3", "4"];
const SOURCE_CODES = ["existing", "known", "new"];

type Body = {
  floristId?: unknown;
  trust_tier?: unknown;
  delivery_radius_km?: unknown;
  capacity_per_day?: unknown;
  business_hours?: unknown;
  payout_terms?: unknown;
  source?: unknown;
  locale?: unknown;
  is_test_shop?: unknown;
  florist_number?: unknown;
  reason?: unknown;
};

/** Partial-update payload built from only the fields the client actually sent —
 * a field absent from the body must never null out the stored value. */
type Update = {
  trust_tier?: string | null;
  delivery_radius_km?: number | null;
  capacity_per_day?: number | null;
  business_hours?: Record<string, unknown> | null;
  payout_terms?: string | null;
  source?: string | null;
  locale?: string | null;
  is_test_shop?: boolean;
  florist_number?: number | null;
};

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let b: Body;
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }

  const floristId = typeof b.floristId === "string" ? b.floristId.trim() : "";
  if (!floristId) return jsonError("floristId must be a non-empty string.", 400);

  const update: Update = {};

  if ("trust_tier" in b) {
    if (b.trust_tier !== null && !(typeof b.trust_tier === "string" && TIER_CODES.includes(b.trust_tier))) {
      return jsonError("trust_tier must be one of 1,2,3,4 or null.", 400);
    }
    update.trust_tier = b.trust_tier as string | null;
  }

  if ("delivery_radius_km" in b) {
    if (b.delivery_radius_km !== null && !(typeof b.delivery_radius_km === "number" && Number.isFinite(b.delivery_radius_km) && b.delivery_radius_km > 0)) {
      return jsonError("delivery_radius_km must be a positive finite number or null.", 400);
    }
    update.delivery_radius_km = b.delivery_radius_km as number | null;
  }

  if ("capacity_per_day" in b) {
    if (b.capacity_per_day !== null && !(typeof b.capacity_per_day === "number" && Number.isInteger(b.capacity_per_day) && b.capacity_per_day > 0)) {
      return jsonError("capacity_per_day must be a positive integer or null.", 400);
    }
    update.capacity_per_day = b.capacity_per_day as number | null;
  }

  if ("source" in b) {
    if (b.source !== null && !(typeof b.source === "string" && SOURCE_CODES.includes(b.source))) {
      return jsonError("source must be one of existing,known,new or null.", 400);
    }
    update.source = b.source as string | null;
  }

  if ("payout_terms" in b) {
    if (b.payout_terms !== null && typeof b.payout_terms !== "string") {
      return jsonError("payout_terms must be a string or null.", 400);
    }
    update.payout_terms = b.payout_terms as string | null;
  }

  if ("locale" in b) {
    // Staff can set/clear the florist's preferred language (drives their app +
    // outbound emails). null = clear (falls back to EN). Same validator the
    // florist self-service picker uses (app/api/florist/locale/route.ts).
    if (b.locale !== null && !isLocale(b.locale)) {
      return jsonError("locale must be one of en,fr,es,it,de or null.", 400);
    }
    update.locale = b.locale as string | null;
  }

  if ("business_hours" in b) {
    const bh = b.business_hours;
    if (bh !== null && (typeof bh !== "object" || Array.isArray(bh))) {
      return jsonError("business_hours must be a plain object or null.", 400);
    }
    update.business_hours = bh as Record<string, unknown> | null;
  }

  if ("is_test_shop" in b) {
    // ADMIN ONLY, unlike every other field on this route. Flagging a shop as a
    // test shop makes test mode send it REAL email/SMS with a WORKING magic
    // link (lib/offerVars.ts) — a login to that shop — and changes whether
    // automatic matching can reach it (lib/match.ts). That is a trust decision,
    // not a day-to-day operational edit.
    if (gate.role !== "admin") return jsonError("Only an admin can change test-shop status.", 403);
    if (typeof b.is_test_shop !== "boolean") return jsonError("is_test_shop must be a boolean.", 400);
    update.is_test_shop = b.is_test_shop;
  }

  if ("florist_number" in b) {
    // Staff-editable either way: a hand-entered legacy ID (arbitrary length/range) or a
    // correction to a mis-set value, in addition to the mint-only POST /api/florists/assign-number
    // path. No shape/range restriction here — isReservedFloristNumber (lib/floristNumber.ts) is a
    // display/labeling helper only, not a validation gate.
    if (b.florist_number !== null && !(typeof b.florist_number === "number" && Number.isInteger(b.florist_number) && b.florist_number > 0)) {
      return jsonError("florist_number must be a positive integer or null.", 400);
    }
    update.florist_number = b.florist_number as number | null;
  }

  if (Object.keys(update).length === 0) return jsonError("No recognized fields in body.", 400);

  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : null;
  const admin = createServiceClient();

  // Only fetch the current row (for the tier-change audit's from_tier, or to
  // detect whether florist_number is actually CHANGING — the Shopify re-send
  // below must not fire on a no-op save) when either field was requested —
  // every other field skips this.
  let tierChanged = false;
  let fromTier: string | null = null;
  let floristNumberChanged = false;
  if ("trust_tier" in update || "florist_number" in update) {
    const { data: current, error: fetchError } = await admin
      .from("florists")
      .select("trust_tier, florist_number")
      .eq("id", floristId)
      .maybeSingle();
    if (fetchError) return jsonError(`Failed to load florist: ${fetchError.message}`, 500);
    if (!current) return jsonError("Florist not found.", 404);
    if ("trust_tier" in update) {
      fromTier = current.trust_tier as string | null;
      tierChanged = fromTier !== update.trust_tier;
    }
    if ("florist_number" in update) {
      floristNumberChanged = (current.florist_number as number | null) !== update.florist_number;
    }
  }

  const { data, error } = await admin
    .from("florists")
    .update(update)
    .eq("id", floristId)
    .select("id");

  if (error) {
    if (error.code === "23505") {
      return jsonError("That Florist ID is already used by another florist.", 409);
    }
    return jsonError(`Failed to update florist: ${error.message}`, 500);
  }
  if (!data || data.length === 0) return jsonError("Florist not found.", 404);

  if (tierChanged) {
    const { error: auditError } = await admin.from("florist_tier_changes").insert({
      florist_id: floristId,
      from_tier: fromTier,
      to_tier: update.trust_tier ?? null,
      changed_by: gate.email,
      reason,
    });
    // Best-effort: the operational update already succeeded; don't fail the
    // request over an audit-row write (mirrors appendOrderEvent's convention
    // in ingest-worker/src/db.ts).
    if (auditError) console.error("florist_tier_changes insert failed:", auditError.message);
  }

  if (floristNumberChanged) {
    // Best-effort, same as every other writeback call site: the operational
    // update already succeeded and must not be undone by a Shopify hiccup.
    await resendFloristNumberForActiveOrders(floristId, update.florist_number ?? null).catch((e) => {
      console.error("resendFloristNumberForActiveOrders failed:", e);
    });
  }

  return Response.json({ ok: true });
}
