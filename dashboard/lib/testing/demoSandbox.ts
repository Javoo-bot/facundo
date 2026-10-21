import "server-only";

import { createServiceClient } from "@/lib/supabaseAdmin";
import { computePayoutPrice } from "@/lib/payoutMath";
import { matchFlorists, DEFAULT_MATCH_CONFIG, type MatchFlorist } from "@/lib/match";
import { resolveDemoSink } from "@/lib/testing/demoSink";
import { orderScenarioById, isOrderScenarioId, UNREACHABLE_DELIVERY_POINT, type OrderScenarioId } from "@/lib/testing/orderScenarios";
import { sendOffer } from "@/lib/reachoutSend";
import { payoutOnAccept, payoutOnDelivered } from "@/lib/payout";
import { mintMagicLink } from "@/lib/floristMagicLinkMint";
import { orderDest } from "@/lib/floristMagicLink";

// The Production/order-loop demo sandbox: creates a demo shop (florists.is_test_shop)
// and a demo order (orders.is_demo) and drives it through one of
// lib/testing/orderScenarios.ts's presets, USING THE REAL order-loop functions
// (matchFlorists, sendOffer, payoutOnAccept/payoutOnDelivered) — a harness that
// mocks the send tests the harness, not the funnel (same philosophy as
// lib/testing/scenarios.ts + app/api/testing/route.ts on the Recruiting side).
//
// SAFETY, restated as invariants this file upholds (see also lib/payout.ts and
// supabase/migrations/2026-08-14-demo-order-sandbox.sql):
//   1. A demo shop's email/phone are ALWAYS app_settings.test_email/test_phone
//      (lib/testing/demoSink.ts), set at creation — never a staff-typed address,
//      never the real thing. Creation is BLOCKED if no test_email is configured.
//   2. Demo matching NEVER reads or writes app_settings.test_shop_matching (the
//      global toggle) — it queries only is_test_shop florists and calls the real
//      matchFlorists() with testShopMatching HARDCODED to 'only' for this one
//      call, so a real customer order's matching is never affected and a demo
//      order can never fail open onto a real florist.
//   3. A demo order is a distinct row (orders.is_demo=true, its own
//      shopify_order_id), optionally traced to a source order via
//      demo_source_order_id — the source order is only ever READ, never written.
//      Buyer/recipient PII from a cloned source order is deliberately NOT
//      copied (see buildOrderContent below) — only product/price data is.
//   4. Payout legs on a demo order's assignment go through the REAL
//      payoutOnAccept/payoutOnDelivered, which (lib/payout.ts) force the ledger
//      rail for any is_test_shop florist regardless of app_settings.payments_live.
//   5. A demo order is never added to the working set (no worklist_at / tag) —
//      it is invisible to every cron/automation pass unless this file's own
//      scenario setup touched it, so the sandbox never interacts with the
//      real order queue.
//
// mintDemoFloristLink (below) adds a sixth, narrower invariant: it mints a
// REAL florist magic link (a live sign-in credential), so it is gated even
// stricter than the rest of this file — see its own doc comment for the
// exact refusal condition.

type Admin = ReturnType<typeof createServiceClient>;

export const DEMO_PLACE_PREFIX = "DEMOKIT_";
export const DEMO_SHOPIFY_PREFIX = "DEMO-";

export interface SetupOrderScenarioInput {
  scenarioId: string;
  /** Which city to anchor the demo shop + order in. Defaults to the first city
   *  with coordinates when omitted. */
  cityId?: string | null;
  /** Optional real order to clone PRODUCT data (line items, total, currency)
   *  from. Buyer/recipient/delivery-address PII is never copied. */
  sourceOrderId?: string | null;
}

export interface SetupOrderScenarioResult {
  ok: boolean;
  orderId?: string;
  floristId?: string | null;
  assignmentId?: string | null;
  steps: string[];
  warnings: string[];
  error?: string;
}

interface DemoCity { id: string; city: string | null; country: string | null; center_lat: number; center_lng: number }

async function resolveCity(admin: Admin, cityId: string | null | undefined): Promise<DemoCity | null> {
  if (cityId) {
    const { data } = await admin.from("cities").select("id, city, country, center_lat, center_lng").eq("id", cityId).maybeSingle();
    return (data as DemoCity | null) ?? null;
  }
  const { data } = await admin
    .from("cities")
    .select("id, city, country, center_lat, center_lng")
    .not("center_lat", "is", null).not("center_lng", "is", null)
    .order("city")
    .limit(1)
    .maybeSingle();
  return (data as DemoCity | null) ?? null;
}

const DEMO_SHOP_RADIUS_KM = 20; // matches DEFAULT_MATCH_CONFIG's cap (ringEdgesKm's last edge)
const NEARBY_OFFSET_KM = 3; // comfortably inside the shop's radius regardless of admin-tuned config

function jitterPoint(lat: number, lng: number, km: number): { lat: number; lng: number } {
  const r = Math.random() * km;
  const bearing = Math.random() * 2 * Math.PI;
  return {
    lat: lat + (r / 111) * Math.cos(bearing),
    lng: lng + (r / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(bearing),
  };
}

/** Find-or-create the ONE canonical demo shop for a city — idempotent across
 *  repeated scenario runs so the sandbox doesn't spawn a fresh florist row
 *  every time staff click "set up". Its email/phone are the sink, always —
 *  never a staff-typed address (contrast app/api/testing/route.ts's real test
 *  shops, which intentionally DO ask for one; this tool never does). */
async function ensureDemoShop(
  admin: Admin,
  city: DemoCity,
  sink: { email: string; phone: string | null }
): Promise<{ ok: true; floristId: string; lat: number; lng: number } | { ok: false; reason: string }> {
  const placeId = `${DEMO_PLACE_PREFIX}${city.id}`;
  const { data: existing } = await admin
    .from("florists")
    .select("id, lat, lng, is_test_shop")
    .eq("city_id", city.id)
    .eq("place_id", placeId)
    .maybeSingle();
  if (existing && existing.is_test_shop === true) {
    // Keep its contact details pinned to the CURRENT sink — an operator could
    // have changed app_settings.test_email since this shop was first created,
    // and a stale address here would silently defeat the whole point.
    await admin.from("florists").update({ email: sink.email, phone_mobile: sink.phone }).eq("id", existing.id);
    return { ok: true, floristId: existing.id, lat: existing.lat ?? city.center_lat, lng: existing.lng ?? city.center_lng };
  }

  const { data: created, error } = await admin
    .from("florists")
    .insert({
      place_id: placeId,
      name: `[DEMO] Sandbox florist — ${city.city ?? "unknown city"}`,
      city_id: city.id,
      email: sink.email,
      phone_mobile: sink.phone,
      is_test_shop: true,
      lifecycle_stage: "production",
      trust_tier: "2",
      delivery_radius_km: DEMO_SHOP_RADIUS_KM,
      lat: city.center_lat,
      lng: city.center_lng,
      joined_at: new Date().toISOString(),
      join_token: crypto.randomUUID(),
      join_token_expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      unsubscribe_token: crypto.randomUUID(),
    })
    .select("id")
    .single();
  if (error || !created) return { ok: false, reason: `Could not create demo shop: ${error?.message ?? "unknown"}` };
  return { ok: true, floristId: created.id, lat: city.center_lat, lng: city.center_lng };
}

interface DemoLineItem {
  title: string; variant: string | null; sku: string | null; quantity: number;
  unit_price: number | null; line_total: number | null; product_type: string | null;
  bouquet_spec: string | null; image_url: string | null;
}

const FIXTURE_LINE_ITEM: DemoLineItem = {
  title: "Demo Bouquet — Roses & Eucalyptus", variant: "Standard", sku: null, quantity: 1,
  unit_price: 55, line_total: 55, product_type: "bouquet",
  bouquet_spec: "Pink roses x6, Eucalyptus x4", image_url: null,
};

/** PRODUCT content only — title/price/spec — never buyer or recipient PII, even
 *  when cloning from a real order. See the module-level safety note (§3). */
async function buildOrderContent(
  admin: Admin,
  sourceOrderId: string | null | undefined
): Promise<{ currency: string; shippingTotal: number | null; total: number | null; lineItems: DemoLineItem[] }> {
  if (sourceOrderId) {
    const [{ data: source }, { data: items }] = await Promise.all([
      admin.from("orders").select("currency, shipping_total, total").eq("id", sourceOrderId).maybeSingle(),
      admin.from("order_line_items")
        .select("title, variant, sku, quantity, unit_price, line_total, product_type, bouquet_spec, image_url")
        .eq("order_id", sourceOrderId),
    ]);
    if (source && items && items.length) {
      return { currency: source.currency ?? "EUR", shippingTotal: source.shipping_total ?? null, total: source.total ?? null, lineItems: items as DemoLineItem[] };
    }
  }
  return { currency: "EUR", shippingTotal: null, total: null, lineItems: [FIXTURE_LINE_ITEM] };
}

export async function setupOrderScenario(admin: Admin, input: SetupOrderScenarioInput): Promise<SetupOrderScenarioResult> {
  const steps: string[] = [];
  const warnings: string[] = [];

  if (!isOrderScenarioId(input.scenarioId)) return { ok: false, steps, warnings, error: "Unknown scenario." };
  const scenario = orderScenarioById(input.scenarioId as OrderScenarioId)!;

  const { data: settings } = await admin
    .from("app_settings")
    .select("test_email, test_phone, default_payout_percent")
    .eq("id", 1)
    .maybeSingle();

  const city = await resolveCity(admin, input.cityId);
  if (!city) return { ok: false, steps, warnings, error: "No city with coordinates available — ingest at least one city first." };

  let floristId: string | null = null;
  let deliveryPoint = { lat: UNREACHABLE_DELIVERY_POINT.lat as number, lng: UNREACHABLE_DELIVERY_POINT.lng as number };

  if (scenario.needsDemoShop) {
    const sink = resolveDemoSink(settings);
    if (!sink.ok) {
      return { ok: false, steps, warnings, error: `Blocked: ${sink.reason} — set Settings → test email before running order scenarios.` };
    }
    const shop = await ensureDemoShop(admin, city, sink.sink);
    if (!shop.ok) return { ok: false, steps, warnings, error: shop.reason };
    floristId = shop.floristId;
    deliveryPoint = jitterPoint(shop.lat, shop.lng, NEARBY_OFFSET_KM);
    steps.push(`demo shop ready (${shop.floristId})`);
  } else {
    steps.push("no demo shop — delivery point placed unreachable on purpose");
  }

  const { currency, shippingTotal, total: sourceTotal, lineItems } = await buildOrderContent(admin, input.sourceOrderId);
  // Cloning a real order: use ITS actual (post-discount) total, not a sum of the
  // cloned line items' pre-discount line_total — summing line_total would
  // reproduce the pre-discount-basis bug this fix corrects (see
  // dashboard/lib/payoutMath.ts::computePayoutPrice) for the payout offer this
  // demo order computes below. The fixture line item has no source order (and no
  // discount to lose), so it falls back to itemsSum + shipping.
  const itemsSum = lineItems.reduce((s, i) => s + (i.line_total ?? 0), 0);
  const total = sourceTotal ?? itemsSum + (shippingTotal ?? 0);
  const suffix = Math.floor(Date.now() / 1000).toString(36).toUpperCase();
  const deliveryAt = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();

  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      shopify_order_id: `${DEMO_SHOPIFY_PREFIX}${Date.now()}`,
      order_name: `#DEMO-${suffix}`,
      is_demo: true,
      demo_source_order_id: input.sourceOrderId ?? null,
      currency, total, shipping_total: shippingTotal,
      financial_status: "paid", fulfillment_status: "unfulfilled",
      // Deliberately synthetic — see the module-level safety note (§3): a
      // cloned order borrows PRODUCT data only, never the buyer's.
      buyer_name: "Demo Buyer", buyer_email: "demo-buyer@facundo.test",
      recipient_name: "Demo Recipient", recipient_phone: "+34600000000",
      delivery_address: { address1: "Carrer de Sandbox 1", city: city.city, zip: "00000", country_code: "ES" },
      delivery_area: `${city.city ?? "Demo"} · Sandbox`,
      delivery_lat: deliveryPoint.lat, delivery_lng: deliveryPoint.lng,
      delivery_at: deliveryAt, delivery_window: "10:00–14:00",
      occasion: "birthday", greeting: "🧪 Demo order — sandbox scenario",
      substitution_policy: "similar_value",
      status: "received",
      notes: `🧪 DEMO — sandbox order (scenario: ${scenario.id}). Never a real Shopify order.`,
    })
    .select("id")
    .single();
  if (orderErr || !order) return { ok: false, steps, warnings, error: `Could not create demo order: ${orderErr?.message ?? "unknown"}` };
  const orderId = order.id as string;
  steps.push(`demo order created (${orderId})`);

  try {
    for (const li of lineItems) {
      const { error } = await admin.from("order_line_items").insert({ order_id: orderId, ...li });
      if (error) throw new Error(`line item: ${error.message}`);
    }

    await admin.from("order_events").insert({
      order_id: orderId, type: "created", actor: "system:demo-sandbox",
      payload: { demo: true, scenario: scenario.id, sourceOrderId: input.sourceOrderId ?? null },
    });

    let assignmentId: string | null = null;

    if (scenario.needsDemoShop && floristId) {
      const payoutPercent = settings?.default_payout_percent ?? 55;
      const payoutPrice = computePayoutPrice(total, payoutPercent);
      // Re-fetch so ranking uses the shop's REAL stored lat/lng, not the
      // delivery jitter above (which is the ORDER's point, not the shop's).
      const { data: floristRow } = await admin
        .from("florists")
        .select("id, place_id, lat, lng, lifecycle_stage, excluded_at, source, trust_tier, delivery_radius_km, capacity_per_day, email, network_id, email_shared_count, email_bounced_at, is_test_shop")
        .eq("id", floristId)
        .single();
      const pool: MatchFlorist[] = floristRow ? [floristRow as unknown as MatchFlorist] : [];
      const ranked = matchFlorists(
        { delivery_lat: deliveryPoint.lat, delivery_lng: deliveryPoint.lng, delivery_at: deliveryAt },
        pool,
        DEFAULT_MATCH_CONFIG,
        "only"
      );

      if (!ranked.length) {
        // Fail CLOSED — same escalation branch as "no nearby shop", with a note
        // explaining it wasn't the scenario's intent.
        warnings.push("Expected the demo shop to match but it didn't (fail-closed) — escalating instead.");
        await admin.from("orders").update({ status: "escalated" }).eq("id", orderId);
        await admin.from("order_events").insert({ order_id: orderId, type: "escalated", actor: "system:demo-sandbox", payload: { demo: true, reason: "no-candidates-unexpected" } });
      } else {
        const slaDeadline = new Date(new Date(deliveryAt).getTime() - 2 * 3600 * 1000).toISOString();
        const { data: assignment, error: aErr } = await admin
          .from("order_assignments")
          .insert({
            order_id: orderId, florist_id: floristId, rank: 1, florist_source: "new",
            status: "candidate", offer_kind: "race", sla_deadline_at: slaDeadline,
            payout_price: payoutPrice, payout_percent: payoutPercent,
            draft_subject: `New Facundo order — ${city.city ?? "Sandbox"}`,
            draft_body: `🧪 Demo scenario (${scenario.id}). Payout €${payoutPrice.toFixed(2)}.`,
          })
          .select("id")
          .single();
        if (aErr || !assignment) throw new Error(`candidate: ${aErr?.message ?? "unknown"}`);
        assignmentId = assignment.id as string;
        await admin.from("orders").update({ status: "matched" }).eq("id", orderId).eq("status", "received");
        await admin.from("order_events").insert({ order_id: orderId, type: "matched", actor: "system:demo-sandbox", payload: { demo: true, candidates: 1, floristId } });
        steps.push(`matched to demo shop (assignment ${assignmentId})`);
      }
    } else {
      await admin.from("orders").update({ status: "escalated" }).eq("id", orderId);
      await admin.from("order_events").insert({ order_id: orderId, type: "escalated", actor: "system:demo-sandbox", payload: { demo: true, reason: "no-nearby-demo-shop" } });
      steps.push("escalated — no demo shop in range (by design)");
    }

    if (assignmentId && scenario.sendsRealOffer) {
      const sent = await sendOffer(assignmentId, "system:demo-sandbox");
      if (!sent.ok) {
        warnings.push(`sendOffer did not deliver: ${sent.error ?? "unknown"} — assignment left as-is.`);
      } else {
        steps.push(`real offer sent to the demo sink (${sent.to ?? "?"})`);
        if (scenario.backdateExpiry) {
          await admin.from("order_assignments").update({ offer_expires_at: new Date(Date.now() - 3600_000).toISOString() }).eq("id", assignmentId);
          steps.push("offer backdated past its expiry — ready for the next wave tick to expire it");
        }
        if (scenario.assignmentStatus === "accepted" || scenario.assignmentStatus === "delivered") {
          await admin.from("order_assignments").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", assignmentId);
          await admin.from("orders").update({ status: "accepted" }).eq("id", orderId);
          steps.push("assignment accepted (seeded — no real florist session exists to click Accept)");
          if (scenario.issueAcceptPayout) {
            const outcome = await payoutOnAccept(assignmentId);
            steps.push(`accept-leg payout: ${outcome.added ? "issued" : outcome.held ? "held" : `not added (${outcome.reason})`} — ledger rail`);
          }
        }
        if (scenario.assignmentStatus === "delivered") {
          await admin.from("order_assignments").update({ status: "delivered", delivered_at: new Date().toISOString() }).eq("id", assignmentId);
          await admin.from("delivery_events").insert({ assignment_id: assignmentId, type: "delivered_photo", photo_key: "demo/sandbox-placeholder.jpg", note: "🧪 demo sandbox — no real photo uploaded" });
          if (scenario.deliveryVerdict) {
            const outcome = await payoutOnDelivered(assignmentId, scenario.deliveryVerdict);
            steps.push(`delivery-leg payout (${scenario.deliveryVerdict}): ${outcome.added ? "issued" : outcome.held ? "held" : `not added (${outcome.reason})`} — ledger rail`);
          }
          await admin.from("orders").update({ status: scenario.orderStatus }).eq("id", orderId);
        }
      }
    }

    return { ok: true, orderId, floristId, assignmentId, steps, warnings };
  } catch (e) {
    // All-or-nothing, like app/api/dev/mock-order/route.ts: never leave a
    // half-seeded demo order behind on failure.
    await admin.from("orders").delete().eq("id", orderId);
    return { ok: false, steps, warnings, error: `Scenario setup failed and was rolled back: ${e instanceof Error ? e.message : "unknown"}` };
  }
}

export interface DemoCleanupResult { ordersDeleted: number; shopsDeleted: number }

/** Removes every demo order (cascades line items/assignments/events/payouts)
 *  and every demo shop. Real orders and real florists are never touched — both
 *  queries filter on the sandbox's own markers (orders.is_demo,
 *  florists.place_id LIKE DEMO_PLACE_PREFIX% AND is_test_shop=true). */
export async function cleanupDemoSandbox(admin: Admin): Promise<DemoCleanupResult> {
  const { data: orders } = await admin.from("orders").delete().eq("is_demo", true).select("id");
  const { data: shops } = await admin
    .from("florists")
    .delete()
    .like("place_id", `${DEMO_PLACE_PREFIX}%`)
    .eq("is_test_shop", true)
    .select("id");
  return { ordersDeleted: orders?.length ?? 0, shopsDeleted: shops?.length ?? 0 };
}

export type MintDemoFloristLinkResult =
  | { ok: true; url: string }
  | { ok: false; reason: "not-found" | "not-demo"; error: string };

/** Mints a real florist magic link for a DEMO assignment so a presenter can
 *  open the florist-side screen — staff with ops/admin hitting
 *  `/florist/m/<token>` get a read-only view-as (app/florist/m/[token]/route.ts),
 *  which is the intended presenter path; this just gets them a token to click.
 *
 *  HARD GATE, deliberately strict because this is a NEW capability (staff
 *  minting a real florist sign-in link): refuses unless BOTH the assignment's
 *  order has `is_demo=true` AND its florist has `is_test_shop=true`. A
 *  staff-triggered magic link for a real florist must be impossible through
 *  this function, full stop — it is the only place that decision is made, so
 *  the route (app/api/testing/orders/route.ts) can stay thin and never itself
 *  decide whether an assignment is "demo enough" to link into. */
export async function mintDemoFloristLink(admin: Admin, assignmentId: string): Promise<MintDemoFloristLinkResult> {
  const { data: assignment, error } = await admin
    .from("order_assignments")
    .select("id, florist_id, orders(is_demo), florists(is_test_shop)")
    .eq("id", assignmentId)
    .maybeSingle();
  if (error || !assignment) return { ok: false, reason: "not-found", error: "Assignment not found." };

  type OneOrMany<T> = T | T[] | null;
  const order = assignment.orders as OneOrMany<{ is_demo?: boolean | null }>;
  const florist = assignment.florists as OneOrMany<{ is_test_shop?: boolean | null }>;
  const isDemoOrder = (Array.isArray(order) ? order[0]?.is_demo : order?.is_demo) === true;
  const isTestShop = (Array.isArray(florist) ? florist[0]?.is_test_shop : florist?.is_test_shop) === true;

  if (!isDemoOrder || !isTestShop) {
    // THE GATE: a staff-triggered florist magic link for a real
    // order/florist must be impossible through this endpoint.
    return { ok: false, reason: "not-demo", error: "Refusing: this assignment is not a demo order against a demo shop." };
  }

  const url = await mintMagicLink(admin, {
    floristId: assignment.florist_id as string,
    dest: orderDest(assignment.id as string),
    purpose: "staff_link",
    assignmentId: assignment.id as string,
  });
  return { ok: true, url };
}

export async function listDemoOrders(admin: Admin) {
  const { data, error } = await admin
    .from("orders")
    .select("id, order_name, status, is_demo, demo_source_order_id, delivery_area, created_at, order_assignments(id, florist_id, status, payout_price, offer_expires_at, accepted_at, delivered_at)")
    .eq("is_demo", true)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, orders: data ?? [] };
}
