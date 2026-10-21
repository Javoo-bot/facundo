import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { haversineKm } from "@/lib/geo";
import { floorPayout } from "@/lib/payoutMath";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Dev/test tool: generate a realistic mock order that lands in `matched` with a
// few candidate florists, so the whole loop (reach-out → step approval → accept →
// deliver → pay) can be walked through without a real Shopify order. Products are
// REAL Facundo catalog items (title, variant, spec, Shopify photo, price)
// sampled from existing line items, so the order looks exactly like a live one.
// Every mock is clearly marked (order_name `#MOCK-…`, shopify id `MOCK-…`, a 🧪
// note, florist_source `mock`) so it's easy to spot and clear. Staff-gated.

const OCCASIONS = ["birthday", "anniversary", "get well soon", "congratulations", "sympathy", "thank you"];
const RECIPIENTS = ["Marta Serra", "Jordi Puig", "Anna Vidal", "Pau Roca", "Laia Ferrer", "Núria Camps"];
const GREETINGS = ["Happy birthday! 🎉", "Thinking of you.", "Congratulations on the big day!", "With all my love.", "Get well soon — we miss you."];

interface Prod {
  title: string; variant: string | null; sku: string | null; bouquet_spec: string | null;
  image_url: string | null; unit_price: number | null; product_type: string | null;
}

// Used only if the DB has no catalog yet (fresh install) — the button never breaks.
const FALLBACK: Prod = {
  title: "Subtle Freshness — Roses & Lilies", variant: "Standard", sku: null,
  bouquet_spec: "Pink roses x8, White lilies x4, Eucalyptus x6", image_url: null, unit_price: 68.9, product_type: "bouquet",
};

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const shuffle = <T,>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5);

// Real Facundo products from existing line items, deduped by (title, variant).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase admin client is loosely typed
async function realProducts(admin: any): Promise<{ bouquets: Prod[]; addons: Prod[] }> {
  const { data } = await admin.from("order_line_items")
    .select("title, variant, sku, bouquet_spec, image_url, unit_price, product_type")
    .not("image_url", "is", null).not("title", "is", null).limit(300);
  const seen = new Set<string>();
  const uniq: Prod[] = [];
  for (const r of (data ?? []) as Prod[]) {
    const k = `${r.title}|${r.variant ?? ""}`;
    if (!seen.has(k)) { seen.add(k); uniq.push(r); }
  }
  return {
    bouquets: uniq.filter((p) => p.product_type === "bouquet"),
    addons: uniq.filter((p) => p.product_type && p.product_type !== "bouquet"),
  };
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;
  const admin = createServiceClient();

  // Optional: pin a specific florist as the top candidate (rank 1). Body may be
  // empty (the plain "Generate" click) — default to the fully random pick.
  const body = await req.json().catch(() => ({}));
  const chosenFloristId = typeof body?.floristId === "string" ? body.floristId : null;

  // --- Deadline controls (QA/A2-deadline-handover-test.md) ---------------------
  // Both optional; omitting them reproduces the original behaviour exactly.
  //
  // `deliveryInHours` pins the delivery deadline instead of the random 1–3 days
  // below, which is what lets one mock order aim at a specific hand-over rule:
  // a +2h30 order makes the CX reserve bind (`out_of_time`), a +4h one runs the
  // full candidate ceiling (`wave_ceiling`), a -1h one is refused outright
  // (`past_delivery_deadline`). Negative is therefore deliberate, not a typo.
  // Bounded to ±1 year so a fat-fingered value can't write a nonsense timestamp.
  const rawHours = Number(body?.deliveryInHours);
  const deliveryInHours = Number.isFinite(rawHours) ? Math.max(-8760, Math.min(8760, rawHours)) : null;
  // A mock order carries no Shopify tags, so with `active_order_tags` set it
  // fails isInWorkingSet and the wave engine never touches it — the deadline
  // test would silently do nothing. `worklist_at` is the other half of that
  // union (an explicit staff pick), so this admits THIS order without widening
  // the tag gate for everyone else's.
  const intoWorkingSet = body?.intoWorkingSet === true;

  const { bouquets, addons } = await realProducts(admin);
  const hero = bouquets.length ? pick(bouquets) : FALLBACK;
  // 0–2 random real add-ons (chocolate / teddy / wine …).
  const chosenAddons = shuffle(addons).slice(0, Math.floor(Math.random() * 3));
  const lineProducts: Prod[] = [hero, ...chosenAddons];
  const total = Math.round(lineProducts.reduce((s, p) => s + (Number(p.unit_price) || 0), 0) * 100) / 100;

  // The onboarded florists an order can actually be MATCHED to (matcher's hard
  // filter: stage production/onboarding + coords; the range check happens below).
  const { data: onboardedRaw } = await admin.from("florists")
    .select("id, name, lat, lng, delivery_radius_km, cities(city)")
    .in("lifecycle_stage", ["production", "onboarding"])
    .is("excluded_at", null).is("deleted_at", null)
    .not("email", "is", null).not("lat", "is", null).not("lng", "is", null);
  type PoolFlorist = { id: string; name: string; lat: number; lng: number; delivery_radius_km: number | null; cities: { city: string } | null };
  const pool = (onboardedRaw ?? []) as unknown as PoolFlorist[];

  // A pinned florist (from the picker) — attached as rank-1 candidate regardless,
  // and used to anchor the delivery when they're a matchable onboarded florist.
  let chosen: PoolFlorist | null = null;
  if (chosenFloristId) {
    const { data } = await admin.from("florists")
      .select("id, name, lat, lng, delivery_radius_km, lifecycle_stage, email, cities(city)")
      .eq("id", chosenFloristId).maybeSingle();
    if (!data) return jsonError("Chosen florist not found.", 404);
    chosen = data as unknown as PoolFlorist;
  }
  const chosenMatchable = !!chosen && pool.some((f) => f.id === chosen!.id);

  // Anchor the delivery INSIDE an onboarded florist's radius so the order is
  // genuinely matchable — the old fixed random box (41.98–42.08 / 2.82–2.92) sat
  // 11–15 km from the Girona florist cluster, outside every 10 km radius, so the
  // matcher returned nobody. Prefer the pinned florist when they're matchable.
  const anchor = chosenMatchable ? chosen! : (pool.length ? pick(pool) : null);
  if (!anchor) {
    return jsonError(
      "No onboarded florist with coordinates to place a matchable mock near. Onboard a florist first (lifecycle stage production/onboarding, with an email and shop coordinates).",
      400,
    );
  }

  // Random point within 60% of the anchor's radius — comfortably in range.
  const radiusKm = anchor.delivery_radius_km ?? 8;
  const rKm = Math.random() * radiusKm * 0.6;
  const bearing = Math.random() * 2 * Math.PI;
  const delivery_lat = anchor.lat + (rKm / 111) * Math.cos(bearing);
  const delivery_lng = anchor.lng + (rKm / (111 * Math.cos((anchor.lat * Math.PI) / 180))) * Math.sin(bearing);
  const cityName = anchor.cities?.city ?? "Girona";
  const area = `${cityName} · Centre`;

  const n = Math.floor(Math.random() * 9000) + 1000;
  const deliveryAt = new Date(
    deliveryInHours != null
      ? Date.now() + deliveryInHours * 3_600_000
      : Date.now() + (1 + Math.floor(Math.random() * 3)) * 86_400_000
  ).toISOString();

  const { data: order, error: oErr } = await admin.from("orders").insert({
    shopify_order_id: `MOCK-${Date.now()}`,
    order_name: `#MOCK-${n}`,
    currency: "EUR", total,
    financial_status: "paid", fulfillment_status: "unfulfilled",
    buyer_name: "Mock Buyer", buyer_email: "mock-buyer@facundo.test",
    recipient_name: pick(RECIPIENTS), recipient_phone: "+34 600 000 000",
    delivery_address: { address1: `Carrer de Test ${n % 100}`, city: cityName, zip: "17001", country_code: "ES" },
    delivery_area: area, delivery_lat, delivery_lng,
    delivery_at: deliveryAt, delivery_window: "10:00–14:00",
    occasion: pick(OCCASIONS), greeting: pick(GREETINGS),
    substitution_policy: "similar_value",
    status: "matched",
    ...(intoWorkingSet ? { worklist_at: new Date().toISOString() } : {}),
    notes: "🧪 Mock order — generated for testing",
  }).select("id").single();
  if (oErr || !order) return jsonError(`Failed to create mock order: ${oErr?.message ?? "unknown"}`, 500);

  // Everything after the order is all-or-nothing: on ANY failure, delete the
  // half-created order so the tool never leaves a bare `matched` order with no
  // items/candidates (the failure the three orphaned #MOCK orders hit — the old
  // code never checked these insert errors and wasn't transactional).
  try {
    for (const p of lineProducts) {
      const { error } = await admin.from("order_line_items").insert({
        order_id: order.id, title: p.title, variant: p.variant, sku: p.sku,
        quantity: 1, unit_price: p.unit_price, line_total: p.unit_price,
        product_type: p.product_type, bouquet_spec: p.bouquet_spec, image_url: p.image_url,
      });
      if (error) throw new Error(`line item: ${error.message}`);
    }

    // Candidates: the pinned florist first (honoured even if out of range — a
    // deliberate override), then the nearest OTHER in-range onboarded florists.
    const candidates: { id: string; name: string }[] = [];
    if (chosen) candidates.push({ id: chosen.id, name: chosen.name });
    const nearby = pool
      .map((f) => ({ f, dist: haversineKm(delivery_lat, delivery_lng, f.lat, f.lng) }))
      .filter((x) => x.dist != null && x.f.id !== chosen?.id && (x.f.delivery_radius_km == null || (x.dist as number) <= x.f.delivery_radius_km))
      .sort((a, b) => (a.dist as number) - (b.dist as number));
    for (const x of nearby) { if (candidates.length >= 3) break; candidates.push({ id: x.f.id, name: x.f.name }); }

    const payout = floorPayout(total * 0.62); // whole units, like the real payout path
    let rank = 1;
    for (const f of candidates) {
      const { error } = await admin.from("order_assignments").insert({
        order_id: order.id, florist_id: f.id, rank, status: "candidate", florist_source: "mock", offer_kind: "race",
        draft_subject: `New Facundo order — ${area}`,
        draft_body: `Hi ${f.name},\n\nYou have a new Facundo order for delivery in ${area} on ${new Date(deliveryAt).toLocaleDateString()} (${hero.title}${hero.variant ? ` · ${hero.variant}` : ""}).\nYour payout: €${payout.toFixed(2)}.\n\nReview and accept in your Facundo dashboard.`,
        payout_price: payout,
      });
      if (error) throw new Error(`candidate ${f.name}: ${error.message}`);
      rank++;
    }

    const { error: evErr } = await admin.from("order_events").insert([
      { order_id: order.id, type: "created", payload: { mock: true }, actor: gate.email },
      { order_id: order.id, type: "matched", payload: { candidates: candidates.length, mock: true, anchor: anchor.id }, actor: "system" },
    ]);
    if (evErr) throw new Error(`events: ${evErr.message}`);

    return Response.json({
      ok: true, orderId: order.id, candidates: candidates.length, items: lineProducts.length,
      // Echoed so a deadline run can be verified without a second query — the
      // A2 test cares about exactly these two.
      deliveryAt, inWorkingSet: intoWorkingSet,
    });
  } catch (e) {
    // Roll back the half-order (line items / assignments cascade on delete).
    await admin.from("orders").delete().eq("id", order.id);
    return jsonError(`Mock setup failed and was rolled back: ${e instanceof Error ? e.message : "unknown"}`, 500);
  }
}

// Clear every mock order (cascades to its assignments/line-items/events/approvals).
export async function DELETE(): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;
  const admin = createServiceClient();
  const { data, error } = await admin.from("orders").delete().like("shopify_order_id", "MOCK-%").select("id");
  if (error) return jsonError(`Failed to clear mock orders: ${error.message}`, 500);
  return Response.json({ ok: true, deleted: data?.length ?? 0 });
}
