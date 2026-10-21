import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { deliveryArea, queueIngestForArea, lookupAreaJob } from "@/lib/autoIngest";
import { loadMatchConfig } from "@/lib/matchConfig";
import { capKm } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scrape the area an order delivers to, on demand from the order page.
//
// The automatic path (ingest-worker/src/autoIngest.ts) only fires in `auto`
// mode, and only for orders that reach matching at all — an order filtered out
// by the active-tag gate never gets there. So the way a coverage gap is
// actually NOTICED is a human opening an order, seeing "0 florists within
// 20km", and wanting to do something about it. This is that button.
//
// Same area derivation and the same idempotency guards as the automatic path,
// with one deliberate difference: `force` lets a human re-scrape an area we've
// already looked at. Automatic firing must never do that (it would re-spend on
// every order landing in a genuinely empty town); a person asking for it is
// making a decision, not a loop.
export async function POST(request: Request): Promise<Response> {
  // Spending Apify + Claude credits is ops/admin, same gate as /api/ingest.
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string; force?: boolean };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId) return jsonError("orderId is required.", 400);

  const admin = createServiceClient();
  const { data: order } = await admin
    .from("orders")
    .select("id, delivery_address, delivery_lat, delivery_lng")
    .eq("id", body.orderId)
    .single();
  if (!order) return jsonError("Order not found.", 404);

  // Scrape as wide as we're willing to MATCH. A narrower radius would leave a
  // ring of addresses permanently uncovered — ingested nothing, matched nothing.
  const config = await loadMatchConfig(admin);
  const area = deliveryArea(order.delivery_address, capKm(config));
  if (!area) {
    return jsonError("This order's delivery address has no city and country, so there's no area to scrape.", 422);
  }
  // Anchor the geocode to where this order actually goes, so a same-named city
  // in a different region (order #2000031's San Carlos/Balears mismatch) can be
  // disambiguated rather than blindly trusting Nominatim's top-ranked match.
  if (order.delivery_lat != null && order.delivery_lng != null) {
    area.nearLat = order.delivery_lat as number;
    area.nearLng = order.delivery_lng as number;
  }

  const outcome = await queueIngestForArea(admin, area, { force: !!body.force });
  const job = await lookupAreaJob(admin, area);

  // Recorded on the order because this is how the coverage gap for THIS order
  // gets closed — a reader six weeks from now should see why it was scraped.
  await admin.from("order_events").insert({
    order_id: body.orderId,
    type: "ingest_queued",
    actor: gate.email,
    payload: {
      country: area.country, city: area.city, radius_km: area.radiusKm, outcome, via: "order-page", forced: !!body.force,
      region: area.region ?? null, near_lat: area.nearLat ?? null, near_lng: area.nearLng ?? null,
    },
  });

  return Response.json({ ok: true, area, outcome, job });
}
