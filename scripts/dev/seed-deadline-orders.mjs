#!/usr/bin/env node
// Seeds the four A2 deadline-hand-over test orders (QA/A2-deadline-handover-test.md).
//
// WHY THIS EXISTS ALONGSIDE THE UI. The same four orders can be made by clicking
// /orders -> the Delivery select -> "Generate mock order", which posts to
// app/api/dev/mock-order. That route is session-gated (requireRole ops/admin), so
// it cannot be driven headlessly — from a terminal, from CI, or by an agent. This
// script is the headless equivalent: same rows, no browser. It deliberately does
// NOT reimplement the pretty parts of that route (real catalog products, add-ons,
// random recipients) because the wave engine does not read any of them. What it
// does have to get right is the four things the engine actually gates on:
//
//   delivery_at   the deadline under test
//   delivery_lat/lng + status='matched'   so waves.ts picks the order up
//   worklist_at   or the working-set gate skips it silently (active_order_tags
//                 is set on staging, and a seeded order carries no Shopify tags)
//   candidate assignments   the list the engine works down
//
// Orders are named #A2-<CASE> and carry shopify_order_id 'MOCK-A2-…', so the
// existing "Clear mocks" button (DELETE app/api/dev/mock-order, which matches
// 'MOCK-%') tears them down along with everything else.
//
// SAFETY. Reads app_settings first and REFUSES to run unless test_mode is on —
// these orders make the wave engine send real offer emails, and without test mode
// they would go to real florists. Nothing here writes settings.
//
// Usage:
//   node scripts/dev/seed-deadline-orders.mjs            # dry run: prints the plan
//   node scripts/dev/seed-deadline-orders.mjs --apply    # actually seeds
//   node scripts/dev/seed-deadline-orders.mjs --apply --only B
//
// Env (from CX/.env): PROJECT_URL, SUPABASE_SERVICE_ROLE_KEY.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Minimal .env reader — avoids a dotenv dependency for a dev script. */
function loadEnv() {
  const out = { ...process.env };
  try {
    for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* env may come from the shell instead */ }
  return out;
}

const env = loadEnv();
const URL_BASE = env.PROJECT_URL || env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) {
  console.error("Missing PROJECT_URL / SUPABASE_SERVICE_ROLE_KEY (looked in CX/.env and the shell).");
  process.exit(1);
}

async function rest(pathname, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${pathname}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const haversineKm = (aLat, aLng, bLat, bLng) => {
  const R = 6371, p = Math.PI / 180;
  const dLat = (bLat - aLat) * p, dLng = (bLng - aLng) * p;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// --- the four cases -----------------------------------------------------------
// `hours` is relative to seeding time. `anchorCity` picks the shop density: a
// dense city can run the full 12-shop ceiling, a sparse one exhausts its pool
// after one wave, which is the entire difference between cases A and D.
const CASES = [
  {
    id: "C", label: "past-deadline", hours: -1, anchorCity: "Girona",
    expect: "escalates on the first tick, zero offers -> past_delivery_deadline",
  },
  {
    id: "B", label: "cx-reserve", hours: 2.5, anchorCity: "Girona",
    expect: "offers on the ladder, then stops early with time left -> out_of_time",
  },
  {
    id: "A", label: "wave-ceiling", hours: 4, anchorCity: "Girona",
    expect: "works the full candidate list, nobody answers -> wave_ceiling",
  },
  {
    id: "D", label: "pool-exhausted", hours: 48, anchorCity: "Arrecife",
    expect: "one wave, refill finds nobody -> pool_exhausted",
  },
];

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

async function main() {
  // --- safety gate ---
  const [settings] = await rest(
    "app_settings?select=test_mode,test_email,workflow_mode,active_order_tags,match_top_n,match_max_waves,cx_reserve_hours,offer_window_rush_min,offer_window_sameday_min,offer_window_standard_min&id=eq.1"
  );
  if (!settings?.test_mode) {
    console.error("REFUSING: app_settings.test_mode is off. These orders cause real offer emails to be sent.");
    console.error("Turn test mode on (Settings -> General) before seeding.");
    process.exit(1);
  }
  console.log(`test mode ON  -> all sends go to ${settings.test_email}`);
  console.log(`workflow_mode = ${settings.workflow_mode}  (the wave engine only sends/refills/escalates in 'auto')`);
  console.log(`ladder = ${settings.offer_window_rush_min}/${settings.offer_window_sameday_min}/${settings.offer_window_standard_min} min   CX reserve = ${settings.cx_reserve_hours}h   ceiling = ${settings.match_max_waves} x ${settings.match_top_n} = ${settings.match_max_waves * settings.match_top_n} shops`);
  if (settings.workflow_mode !== "auto") {
    console.warn("WARNING: not in 'auto' — the engine will file approvals instead of sending, and none of the A2 timings will happen.");
  }
  console.log("");

  const florists = await rest(
    "florists?select=id,name,lat,lng,delivery_radius_km,cities(city)" +
    "&lifecycle_stage=in.(production,onboarding)&excluded_at=is.null&deleted_at=is.null" +
    "&email=not.is.null&lat=not.is.null&lng=not.is.null&limit=500"
  );

  // One real catalog line item, so the payout basis is realistic. Falls back to a
  // fixed price if the project has no line items yet.
  const products = await rest(
    "order_line_items?select=title,variant,unit_price,product_type,bouquet_spec,image_url" +
    "&unit_price=not.is.null&product_type=eq.bouquet&limit=1"
  );
  const product = products?.[0] ?? {
    title: "Subtle Freshness — Roses & Lilies", variant: "Standard", unit_price: 68.9,
    product_type: "bouquet", bouquet_spec: null, image_url: null,
  };

  for (const c of CASES) {
    if (only && c.id !== only) continue;

    const pool = florists.filter((f) => (f.cities?.city ?? null) === c.anchorCity);
    if (!pool.length) {
      console.error(`  ${c.id}: no onboarded florist in ${c.anchorCity} — skipped.`);
      continue;
    }
    const anchor = pool[0];
    // A point comfortably inside the anchor's radius, so matching genuinely finds
    // shops rather than the order landing just outside every circle.
    const radiusKm = anchor.delivery_radius_km ?? 8;
    const rKm = radiusKm * 0.3;
    const lat = anchor.lat + (rKm / 111);
    const lng = anchor.lng;

    const inRange = florists
      .map((f) => ({ f, d: haversineKm(lat, lng, f.lat, f.lng) }))
      .filter((x) => x.f.delivery_radius_km == null || x.d <= x.f.delivery_radius_km)
      .sort((a, b) => a.d - b.d);
    const topN = settings.match_top_n ?? 3;
    const candidates = inRange.slice(0, topN);

    const deliveryAt = new Date(Date.now() + c.hours * 3_600_000).toISOString();
    const price = Number(product.unit_price) || 68.9;
    const payout = Math.floor(price * 0.62);

    console.log(`  ${c.id} (${c.label})  delivery ${c.hours >= 0 ? "+" : ""}${c.hours}h -> ${deliveryAt}`);
    console.log(`      anchor ${anchor.name} (${c.anchorCity}) · ${inRange.length} shops in range · ${candidates.length} candidates seeded`);
    console.log(`      expect: ${c.expect}`);
    if (c.id === "A" && inRange.length < (settings.match_max_waves ?? 4) * topN) {
      console.warn(`      NOTE: only ${inRange.length} shops in range but the ceiling is ${(settings.match_max_waves ?? 4) * topN} — this will end pool_exhausted, not wave_ceiling.`);
    }
    if (!APPLY) { console.log(""); continue; }

    const n = Math.floor(Math.random() * 9000) + 1000;
    const [order] = await rest("orders", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify([{
        shopify_order_id: `MOCK-A2-${c.id}-${Date.now()}`,
        order_name: `#A2-${c.id}-${n}`,
        currency: "EUR", total: price,
        financial_status: "paid", fulfillment_status: "unfulfilled",
        buyer_name: "A2 Deadline Test", buyer_email: "a2-test@facundo.test",
        recipient_name: "Marta Serra", recipient_phone: "+34 600 000 000",
        delivery_address: { address1: `Carrer de Test ${n % 100}`, city: c.anchorCity, zip: "17001", country_code: "ES" },
        delivery_area: `${c.anchorCity} · Centre`,
        delivery_lat: lat, delivery_lng: lng,
        delivery_at: deliveryAt, delivery_window: "10:00–14:00",
        occasion: "birthday", greeting: "Happy birthday!",
        substitution_policy: "similar_value",
        status: "matched",
        // Without this the working-set gate skips the order and nothing happens.
        worklist_at: new Date().toISOString(),
        notes: `🧪 A2 deadline test — case ${c.id} (${c.label}). ${c.expect}`,
      }]),
    });

    await rest("order_line_items", {
      method: "POST",
      body: JSON.stringify([{
        order_id: order.id, title: product.title, variant: product.variant,
        quantity: 1, unit_price: price, line_total: price,
        product_type: product.product_type, bouquet_spec: product.bouquet_spec, image_url: product.image_url,
      }]),
    });

    await rest("order_assignments", {
      method: "POST",
      body: JSON.stringify(candidates.map((x, i) => ({
        order_id: order.id, florist_id: x.f.id, rank: i + 1,
        status: "candidate", florist_source: "mock",
        // rank 1 exclusive mirrors ingest-worker/src/db.ts::insertCandidates.
        offer_kind: i === 0 ? "exclusive" : "race",
        payout_price: payout,
        draft_subject: `New Facundo order — ${c.anchorCity} · Centre`,
        draft_body: `Hi ${x.f.name},\n\nYou have a new Facundo order for delivery in ${c.anchorCity} (${product.title}).\nYour payout: €${payout.toFixed(2)}.\n\nReview and accept in your Facundo dashboard.`,
      }))),
    });

    await rest("order_events", {
      method: "POST",
      body: JSON.stringify([
        { order_id: order.id, type: "created", payload: { a2_case: c.id }, actor: "a2-seed" },
        { order_id: order.id, type: "matched", payload: { candidates: candidates.length, a2_case: c.id, anchor: anchor.id }, actor: "system" },
      ]),
    });

    console.log(`      seeded ${order.order_name}  id=${order.id}`);
    console.log("");
  }

  if (!APPLY) console.log("Dry run. Re-run with --apply to seed.");
  else console.log("Seeded. Leave them alone; the per-minute cron does the rest.\nTear down with 'Clear mocks' on /orders, or delete where shopify_order_id like 'MOCK-A2-%'.");
}

main().catch((e) => { console.error(e); process.exit(1); });
