import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { resendFloristNumberForActiveOrders } from "@/lib/shopifyWriteback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  floristId?: unknown;
};

/**
 * Mint (or return the existing) Facundo Florist ID for a shop, via the
 * `assign_florist_number` DB function (supabase/migrations/2026-08-21-florist-number.sql).
 * Race-safe by construction: the RPC is a single atomic UPDATE whose row lock
 * serializes concurrent callers for the same florist, so two staff clicking
 * at once still mint exactly one number and both requests resolve to the
 * same persisted value — see the function's own comment for why the earlier
 * check-then-act version of this RPC did not have that guarantee.
 *
 * `alreadyAssigned` in the response reflects the pre-call read below — it's
 * informational (lets the UI say "already had one" vs "just minted"), not
 * part of the atomicity guarantee, which lives entirely in the RPC.
 *
 * A freshly minted number (alreadyAssigned false) is resent to Shopify for
 * this florist's active orders here — the RPC persists florist_number
 * directly, so by the time the Operational panel's own Save reaches
 * POST /api/florists/operational, `florist_number` in the DB already matches
 * what's being saved and that route's change-detection sees no diff, never
 * firing its own resend. Re-minting an already-assigned number is a no-op
 * RPC call (coalesce short-circuits), so no resend fires for that case either
 * — nothing actually changed.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let b: Body;
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }

  const floristId = typeof b.floristId === "string" ? b.floristId.trim() : "";
  if (!floristId) return jsonError("floristId must be a non-empty string.", 400);

  const admin = createServiceClient();

  const { data: current, error: fetchError } = await admin
    .from("florists")
    .select("florist_number")
    .eq("id", floristId)
    .maybeSingle();
  if (fetchError) return jsonError(`Failed to load florist: ${fetchError.message}`, 500);
  if (!current) return jsonError("Florist not found.", 404);
  const alreadyAssigned = current.florist_number != null;

  const { data: florist_number, error } = await admin.rpc("assign_florist_number", { p_florist_id: floristId });
  if (error) {
    captureError("florists.assign_number_failed", error);
    return jsonError(`Failed to assign florist number: ${error.message}`, 500);
  }

  if (!alreadyAssigned && florist_number != null) {
    // Best-effort, same as every other writeback call site: the mint already
    // succeeded and must not be undone by a Shopify hiccup.
    await resendFloristNumberForActiveOrders(floristId, florist_number).catch((e) => {
      console.error("resendFloristNumberForActiveOrders failed:", e);
    });
  }

  return Response.json({ florist_number, alreadyAssigned });
}
