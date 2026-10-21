import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { loadMatchConfig, applyConfigOverride } from "@/lib/matchConfig";
import { rankForOrder, isRankError } from "@/lib/rematch";
import { capKm } from "@/lib/match";
import { deliveryArea, lookupAreaJob } from "@/lib/autoIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rank an order's florists and EXPLAIN the ranking — writes nothing.
//
// Backs the "Find florists" panel: the operator adjusts rings, weights and
// floors, sees the resulting order with each candidate's ring and per-term score
// breakdown, then commits through POST /api/orders/rematch with the same
// `config` body. Both routes rank through lib/rematch.ts, so the preview is not
// an approximation of what commit will do — it is the same computation.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string; config?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId) return jsonError("orderId is required.", 400);

  const admin = createServiceClient();
  const saved = await loadMatchConfig(admin);
  const config = applyConfigOverride(saved, body.config);
  const result = await rankForOrder(admin, body.orderId, config);
  if (isRankError(result)) return jsonError(result.error, result.status);

  // The delivery area and whatever we already know about scraping it, so the
  // panel can say "never scraped" vs "scraped 3 weeks ago, found 0" instead of
  // offering a button whose effect is a mystery.
  const { data: order } = await admin
    .from("orders").select("delivery_address").eq("id", body.orderId).single();
  const area = deliveryArea(order?.delivery_address, capKm(config));
  const areaJob = area ? await lookupAreaJob(admin, area) : null;

  return Response.json({
    area,
    areaJob,
    ok: true,
    // Echoed back so the panel can seed its controls from the saved values on
    // first open, and show what a malformed override actually resolved to.
    saved,
    config,
    capKm: capKm(config),
    // Everything in range, best-first, including the already-assigned rows the
    // commit will skip — an operator asking "why isn't this shop offered?"
    // deserves to see it listed with a reason rather than absent.
    candidates: result.ranked.map((c) => ({
      floristId: c.florist_id,
      name: c.florist_name,
      rank: c.rank,
      ring: c.ring,
      distanceKm: c.distance_km,
      score: c.score,
      breakdown: c.breakdown,
      source: c.source,
      alreadyAssigned: c.already_assigned,
    })),
    // What a commit would insert, in order.
    wouldAdd: result.fresh.map((c) => c.florist_id),
    consideredCount: result.consideredCount,
  });
}
