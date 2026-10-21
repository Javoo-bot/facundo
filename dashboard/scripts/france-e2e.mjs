// France end-to-end test harness — seed, watch, clean.
//
//   node --import ./scripts/alias-loader-register.mjs scripts/france-e2e.mjs settings
//   node --import ./scripts/alias-loader-register.mjs scripts/france-e2e.mjs seed [--only A1]
//   node --import ./scripts/alias-loader-register.mjs scripts/france-e2e.mjs watch
//   node --import ./scripts/alias-loader-register.mjs scripts/france-e2e.mjs clean
//
// WHY THIS EXISTS: the five scenarios the Thursday task names have to run against
// the REAL French florist pool through the REAL matcher, not a fixture. So this
// script does exactly what the webhook intake path does and no more:
//
//   1. insert the order at status 'received' with no candidates
//      (advanceWaves only ever selects 'matched'/'reaching_out', so a 'received'
//       order cannot be escalated out from under us while we set up — which is
//       the trap 04-create-matched-order.sql warns about)
//   2. run the real rankForOrder + refillCandidates
//   3. mirror ingest-worker/src/lateMatch.ts:211 exactly:
//        setOrderStatus(candidates.length ? "matched" : "escalated")
//      — including the fact that it writes NO escalation_reason. That omission
//      is under test; do not "fix" it here.
//
// Then the deployed wave-engine cron (every minute) owns the order.
//
// CONTAINMENT: every order is tagged QA-AUTO (the live active_order_tags value)
// and carries worklist_at, so it is inside the working set and nothing else is.
// Markers: shopify_order_id 'FRTEST-<id>', order_name '#FRTEST-<id>'.

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const { createServiceClient } = await import("../lib/supabaseAdmin.ts");
const { loadMatchConfig } = await import("../lib/matchConfig.ts");
const { rankForOrder, isRankError } = await import("../lib/rematch.ts");
const { refillCandidates, isRefillError } = await import("../lib/candidateRefill.ts");

const admin = createServiceClient();
const MARKER = "FRTEST-";
const ACTOR = "france-e2e@fc.example.com";

// ---------------------------------------------------------------------------
// The scenarios. Coordinates are real and were chosen from the live florist
// table by measuring distance to the nearest shop (see the deliverable's
// coverage table), not guessed:
//
//   Paris 11e   642 florists within 20km, 240 of them emailable
//   Fourmies     50 florists within 20km,   0 emailable (nearest emailable 72.8km)
//   Mende         0 florists within 20km   (nearest 56.3km — outside the ring cap)
//
// `leadHours` is measured from NOW, not from shopifyCreatedAt: every gate in the
// loop (coldOfferBlockReason, suggestedTimeoutMinutes, refillDecision) compares
// delivery_at against the clock, so that is what decides the outcome. The 02:00
// shopifyCreatedAt on the night cases is real provenance, not the gate input.
// ---------------------------------------------------------------------------
const H = 3600 * 1000;

const SCENARIOS = [
  {
    id: "A1", slug: "paris-with-florist",
    title: "City with a florist",
    lat: 48.8566, lng: 2.3522, area: "Paris · Île-de-France",
    address: { line1: "9 Rue de Liège", line2: null, city: "Paris", postal: "75009", region: "Île-de-France", country: "FR" },
    leadHours: 72,
    expect: "Candidates written; cold-offer gate evaluated per shop; offers auto-sent in auto mode; order → reaching_out",
  },
  {
    id: "A2", slug: "mende-no-florist",
    title: "City without a florist",
    lat: 44.5180, lng: 3.5008, area: "Mende · Lozère",
    address: { line1: "12 Rue de l'Ange", line2: null, city: "Mende", postal: "48000", region: "Occitanie", country: "FR" },
    leadHours: 72,
    expect: "0 candidates → escalated. escalation_reason SHOULD be set (finding #3 predicts NULL)",
  },
  {
    id: "A3", slug: "fourmies-no-email",
    title: "Florists present, none contactable",
    lat: 50.0167, lng: 4.05, area: "Fourmies · Hauts-de-France",
    address: { line1: "3 Place Georges Coppeaux", line2: null, city: "Fourmies", postal: "59610", region: "Hauts-de-France", country: "FR" },
    leadHours: 72,
    expect: "Candidates written, then every cold offer blocked no-email",
  },
  {
    id: "A4", slug: "night-normal",
    title: "Night order, normal lead",
    lat: 48.8566, lng: 2.3522, area: "Paris · Île-de-France",
    address: { line1: "22 Rue Oberkampf", line2: null, city: "Paris", postal: "75011", region: "Île-de-France", country: "FR" },
    leadHours: 7, nightStamp: true,
    expect: "Offers sent regardless of hour — no quiet-hours gate exists anywhere in the loop",
  },
  {
    id: "A5", slug: "night-rush",
    title: "Night order, rush (under the 6h cold-offer floor)",
    lat: 48.8566, lng: 2.3522, area: "Paris · Île-de-France",
    address: { line1: "5 Rue de Belleville", line2: null, city: "Paris", postal: "75019", region: "Île-de-France", country: "FR" },
    leadHours: 4, nightStamp: true,
    expect: "COLD_OFFER_MIN_LEAD_HOURS=6 → every candidate blocked too-urgent → waits for a human. 18.2% of real orders",
  },
  {
    id: "A6", slug: "past-deadline",
    title: "Delivery already in the past on arrival",
    lat: 48.8566, lng: 2.3522, area: "Paris · Île-de-France",
    address: { line1: "40 Rue de Rivoli", line2: null, city: "Paris", postal: "75004", region: "Île-de-France", country: "FR" },
    leadHours: -18,
    expect: "past_delivery_deadline, no offers. 7.2% of real orders arrive like this",
  },
  {
    id: "A7", slug: "payout-ceiling",
    title: "Payout over the cold-offer ceiling",
    lat: 48.8566, lng: 2.3522, area: "Paris · Île-de-France",
    address: { line1: "1 Avenue des Champs-Élysées", line2: null, city: "Paris", postal: "75008", region: "Île-de-France", country: "FR" },
    leadHours: 72, totalOverride: 250,
    expect: "55% = €137.50 > cold_offer_max_payout_eur 120 → blocked payout-too-high",
  },

  // --- The cold-offer set -------------------------------------------------
  // A1/A4/A5/A7 above all matched the SAME shop — Paris's single
  // lifecycle_stage='production' florist — because match_weight_onboarded is
  // 3.0, the heaviest weight in the config, so the one onboarded shop wins rank
  // 1 on every Paris order regardless of distance. offer_audience came back
  // 'network' and coldOfferBlockReason() was never consulted, so those three
  // scenarios cannot test the cold gates they were written for.
  //
  // Lyon has 165 florists, 63 emailable and ZERO in production/onboarding —
  // which is the shape of 38 of France's 40 ingested cities. It is the honest
  // French case, and the only way to reach the cold path.
  {
    id: "C1", slug: "lyon-cold-normal",
    title: "Cold offer, clean — city with no network shop",
    lat: 45.7640, lng: 4.8357, area: "Lyon · Auvergne-Rhône-Alpes",
    address: { line1: "14 Rue de la République", line2: null, city: "Lyon", postal: "69002", region: "Auvergne-Rhône-Alpes", country: "FR" },
    leadHours: 72,
    expect: "Every gate passes → cold offer auto-sent, offer_audience='cold'",
  },
  {
    id: "C2", slug: "lyon-cold-too-urgent",
    title: "Cold offer under the 6h floor",
    lat: 45.7640, lng: 4.8357, area: "Lyon · Auvergne-Rhône-Alpes",
    address: { line1: "8 Place Bellecour", line2: null, city: "Lyon", postal: "69002", region: "Auvergne-Rhône-Alpes", country: "FR" },
    leadHours: 4, nightStamp: true,
    expect: "COLD_OFFER_MIN_LEAD_HOURS=6 → blocked too-urgent → approval, waits for a human",
  },
  {
    id: "C3", slug: "lyon-cold-payout-high",
    title: "Cold offer over the payout ceiling",
    lat: 45.7640, lng: 4.8357, area: "Lyon · Auvergne-Rhône-Alpes",
    address: { line1: "1 Quai Jules Courmont", line2: null, city: "Lyon", postal: "69002", region: "Auvergne-Rhône-Alpes", country: "FR" },
    leadHours: 72, totalOverride: 250,
    expect: "€137 > cold_offer_max_payout_eur 120 → blocked payout-too-high",
  },
  {
    id: "C4", slug: "lyon-cold-auto-cap",
    title: "Cold offer between the auto cap and the ceiling",
    lat: 45.7640, lng: 4.8357, area: "Lyon · Auvergne-Rhône-Alpes",
    address: { line1: "20 Rue Victor Hugo", line2: null, city: "Lyon", postal: "69002", region: "Auvergne-Rhône-Alpes", country: "FR" },
    leadHours: 72, totalOverride: 190,
    expect: "€104 is over cold_offer_auto_payout_cap_eur 90 but under the 120 ceiling → sends, but the accept leg should be HELD",
  },
];

// ---------------------------------------------------------------------------

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const cmd = process.argv[2] ?? "settings";
const only = arg("--only");

/** Pick a real French order to clone product/price from. PII is never copied. */
async function sourceOrder() {
  const { data } = await admin
    .from("orders")
    .select("id, order_name, currency, total, shipping_total, tags")
    .eq("is_demo", false)
    .not("total", "is", null)
    .gt("total", 60)
    .order("shopify_created_at", { ascending: false })
    .limit(200);
  // Prefer one that actually has line items, so the offer email renders a bouquet.
  for (const o of data ?? []) {
    const { count } = await admin
      .from("order_line_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", o.id);
    if ((count ?? 0) > 0) return { ...o, itemCount: count };
  }
  return data?.[0] ?? null;
}

async function seed() {
  const src = await sourceOrder();
  if (!src) throw new Error("no source order found to clone from");
  console.log(`cloning product/price from ${src.order_name} (${src.total} ${src.currency}, ${src.itemCount ?? 0} line items)\n`);

  const { data: settings } = await admin
    .from("app_settings")
    .select("default_payout_percent")
    .eq("id", 1)
    .single();
  const pct = settings?.default_payout_percent ?? 55;
  const config = await loadMatchConfig(admin);
  const now = Date.now();

  const list = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;

  for (const s of list) {
    const total = s.totalOverride ?? src.total;
    const deliveryAt = new Date(now + s.leadHours * H);
    // Real provenance for the night cases: stamped 02:00 CET (00:00 UTC) today.
    const created = s.nightStamp
      ? new Date(new Date().setUTCHours(0, 0, 0, 0))
      : new Date(now);

    const marker = `${MARKER}${s.id}`;
    const { data: order, error } = await admin
      .from("orders")
      .insert({
        shopify_order_id: marker,
        order_name: `#${marker}`,
        shopify_created_at: created.toISOString(),
        currency: src.currency ?? "EUR",
        total,
        shipping_total: src.shipping_total,
        financial_status: "paid",
        fulfillment_status: null,
        // Mirrors the parsers now that they derive it from the delivery country
        // (ingest-worker/src/shopify.ts, dashboard/lib/shopifyParse.ts): Shopify
        // sends no locale for French traffic, so FR → 'fr'.
        locale: "fr",
        buyer_name: "Test Buyer",
        buyer_email: process.env.FRANCE_E2E_BUYER ?? "owner@fc.example.com",
        buyer_phone: null,
        recipient_name: "Test Recipient",
        recipient_phone: "+33600000000",
        delivery_address: s.address,
        delivery_area: s.area,
        delivery_lat: s.lat,
        delivery_lng: s.lng,
        delivery_at: deliveryAt.toISOString(),
        delivery_window: null,
        occasion: "birthday",
        greeting: "Joyeux anniversaire !",
        substitution_policy: null,
        status: "received", // NOT 'matched' — see header
        notes: `FRANCE E2E ${s.id} — ${s.title}. Product/price cloned from ${src.order_name}; all PII invented.`,
        worklist_at: new Date().toISOString(),
        worklist_by: ACTOR,
        tags: "QA-AUTO",
        is_demo: false,
        raw: { synthetic: true, scenario: s.id, cloned_from: src.order_name },
      })
      .select("id, order_name, delivery_at, total")
      .single();

    if (error) {
      console.log(`${s.id} INSERT FAILED: ${error.message}`);
      continue;
    }

    // Clone the line items so the offer email renders a real bouquet.
    const { data: items } = await admin.from("order_line_items").select("*").eq("order_id", src.id);
    if (items?.length) {
      const copies = items.map(({ id, order_id, created_at, ...rest }) => ({ ...rest, order_id: order.id }));
      const { error: ierr } = await admin.from("order_line_items").insert(copies);
      if (ierr) console.log(`   line items: ${ierr.message}`);
    }

    // --- the real matcher, exactly as the webhook path runs it ---------------
    const ranked = await rankForOrder(admin, order.id, config);
    let added = 0;
    let considered = 0;
    let rankNote = "";
    if (isRankError(ranked)) {
      rankNote = `rank error: ${ranked.error}`;
    } else {
      considered = ranked.ranked.length;
      const written = await refillCandidates(admin, order.id, config, { actor: ACTOR, preRanked: ranked });
      if (isRefillError(written)) rankNote = `refill error: ${written.error}`;
      else added = written.added;
    }

    // Mirror lateMatch.ts:211 — including the missing escalation_reason.
    const nextStatus = added > 0 ? "matched" : "escalated";
    await admin.from("orders").update({ status: nextStatus }).eq("id", order.id);
    await admin.from("order_events").insert({
      order_id: order.id,
      type: nextStatus === "matched" ? "matched" : "escalated",
      payload: { france_e2e: s.id, candidates: added, considered, note: rankNote || null },
      actor: "system",
    });

    const payout = Math.floor((Math.round(total * 100) * pct) / 10000 + 0.000001);
    console.log(
      `${s.id} ${s.slug.padEnd(22)} ${order.order_name.padEnd(14)} ` +
        `lead ${String(s.leadHours).padStart(3)}h  €${String(total).padStart(6)}  payout €${payout}  ` +
        `ranked ${String(considered).padStart(3)} → wrote ${String(added).padStart(2)}  → ${nextStatus}` +
        (rankNote ? `  [${rankNote}]` : "")
    );
  }
  console.log("\nthe wave-engine cron owns these now — one tick per minute.");
}

async function watch() {
  const { data: orders } = await admin
    .from("orders")
    .select("id, order_name, status, escalation_reason, delivery_at, total, delivery_area")
    .like("shopify_order_id", `${MARKER}%`)
    .order("order_name");

  if (!orders?.length) return console.log("no FRTEST orders — run `seed` first.");

  console.log(
    "id   order          status        esc_reason              cands  sent  exp  acc  dec  approvals(kind/block)"
  );
  for (const o of orders) {
    const { data: a } = await admin
      .from("order_assignments")
      .select("status, offer_audience, sent_at, offer_expires_at, florist_id")
      .eq("order_id", o.id);
    const { data: ap } = await admin
      .from("order_approvals")
      .select("kind, status, block_reason")
      .eq("order_id", o.id);
    const n = (st) => (a ?? []).filter((x) => x.status === st).length;
    const approvals = (ap ?? []).map((x) => `${x.kind}${x.block_reason ? "/" + x.block_reason : ""}:${x.status}`).join(" ");
    console.log(
      `${o.order_name.replace("#" + MARKER, "").padEnd(4)} ${o.order_name.padEnd(14)} ` +
        `${String(o.status).padEnd(13)} ${String(o.escalation_reason ?? "—").padEnd(23)} ` +
        `${String((a ?? []).length).padStart(5)} ${String(n("sent")).padStart(5)} ${String(n("expired")).padStart(4)} ` +
        `${String(n("accepted")).padStart(4)} ${String(n("declined")).padStart(4)}  ${approvals}`
    );
  }
}

async function clean() {
  const { data: orders } = await admin.from("orders").select("id, order_name").like("shopify_order_id", `${MARKER}%`);
  if (!orders?.length) return console.log("nothing to clean.");
  const ids = orders.map((o) => o.id);
  const { data: asg } = await admin.from("order_assignments").select("id").in("order_id", ids);
  const asgIds = (asg ?? []).map((a) => a.id);
  if (asgIds.length) {
    await admin.from("payouts").delete().in("assignment_id", asgIds);
    await admin.from("conversations").delete().in("assignment_id", asgIds);
  }
  for (const t of ["order_approvals", "order_events", "order_issues", "order_assignments", "order_line_items", "delivery_events"]) {
    const { error } = await admin.from(t).delete().in("order_id", ids);
    if (error && !/does not exist/.test(error.message)) console.log(`  ${t}: ${error.message}`);
  }
  const { error } = await admin.from("orders").delete().in("id", ids);
  console.log(error ? `orders: ${error.message}` : `removed ${orders.length} FRTEST orders and their children.`);
}

async function settings() {
  const { data } = await admin.from("app_settings").select("*").eq("id", 1).single();
  const KEYS = [
    "workflow_mode", "test_mode", "test_email", "test_phone", "test_shop_matching",
    "active_order_tags", "payments_live", "payments_paused", "hold_delivery_payouts",
    "shopify_writeback_enabled", "default_payout_percent",
    "offer_window_rush_min", "offer_window_sameday_min", "offer_window_standard_min",
    "offer_window_far_min", "offer_window_nodate_min", "cx_reserve_hours",
    "match_max_waves", "match_top_n", "match_ring_edges_km",
    "cold_offer_enabled", "cold_offer_max_payout_eur", "cold_offer_auto_payout_cap_eur",
    "cold_offer_default_radius_km", "email_offer_enabled", "sms_offer_enabled",
  ];
  console.log(JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, data?.[k]])), null, 2));
}

/**
 * Fast-forward one order through its wave ladder by back-dating ONLY its live
 * offer's `offer_expires_at`. The next cron tick then expires it and moves to
 * the next candidate.
 *
 * Deliberately per-assignment. Lowering the global `offer_window_*_min` would
 * reach every order in the working set and would also change the very number
 * this test is measuring — that global is exactly what was found set to 1
 * minute, and re-creating that state to save time would be self-defeating.
 */
async function compress() {
  const target = arg("--order");
  if (!target) return console.log("usage: compress --order A1");
  const { data: o } = await admin
    .from("orders")
    .select("id, order_name, status")
    .eq("shopify_order_id", `${MARKER}${target}`)
    .single();
  if (!o) return console.log(`no order ${MARKER}${target}`);

  const { data: live } = await admin
    .from("order_assignments")
    .select("id, florist_id, offer_expires_at")
    .eq("order_id", o.id)
    .in("status", ["sent", "opened"]);
  if (!live?.length) return console.log(`${o.order_name} (${o.status}) — no live offer to compress`);

  const past = new Date(Date.now() - 60_000).toISOString();
  for (const a of live) {
    await admin.from("order_assignments").update({ offer_expires_at: past }).eq("id", a.id);
    console.log(`${o.order_name}: offer ${a.id.slice(0, 8)} expiry ${a.offer_expires_at} → ${past}`);
  }
}

/** Create (or reuse) the France test shop Pass B needs. */
async function shop() {
  const EMAIL = process.env.FRANCE_E2E_SHOP_EMAIL ?? "owner+frtest@fc.example.com";
  const PLACE = "FRTESTSHOP_paris";
  const { data: existing } = await admin.from("florists").select("id, name, email").eq("place_id", PLACE).maybeSingle();
  if (existing) return console.log(`reusing ${existing.name} (${existing.id}) — ${existing.email}`);

  const { data: city } = await admin
    .from("cities")
    .select("id")
    .eq("country", "FR")
    .ilike("city", "Paris")
    .limit(1)
    .single();

  // is_test_shop = true is what buys the clickable magic link: offerVars.ts:240
  // computes redirectToTestInbox = testMode && !testShop, and only a false
  // there mints a real token. The address is one we own, so nothing reaches a
  // real florist either way.
  const { data, error } = await admin
    .from("florists")
    .insert({
      city_id: city?.id ?? null,
      place_id: PLACE,
      name: "[FR-TEST] Fleurs de Test Paris",
      address: "12 Rue de Rivoli, 75004 Paris",
      lat: 48.8566, lng: 2.3522,
      rating: 4.6, review_count: 88,
      email: EMAIL,
      phone_maps: "+33100000000",
      locale: "fr",
      lifecycle_stage: "production",
      trust_tier: "2",
      delivery_radius_km: 20,
      is_test_shop: true,
      source: "new",
      onboarded_at: new Date().toISOString(),
      joined_at: new Date().toISOString(),
      order_emails_opt_out: false,
    })
    .select("id, name, email")
    .single();
  console.log(error ? `FAILED: ${error.message}` : `created ${data.name} (${data.id}) — ${data.email}`);
}

/**
 * Pass B: an order pinned to the France test shop, for the florist half.
 *
 * Deliberately does NOT flip `app_settings.test_shop_matching` to 'only'.
 * That toggle is consulted by passesHardFilter during MATCHING, not by
 * sendOffer — so writing the candidate row by hand reaches the same shop
 * without a global setting that, while it is on, would divert every other
 * order in the working set to test shops too. The narrower move is the right
 * one when the wider one buys nothing.
 *
 * The shop is lifecycle_stage='production', so the wave engine takes the
 * `candOnboarded` branch and never consults the cold-offer gate — matching the
 * two real onboarded French shops.
 */
async function passb() {
  const label = arg("--id") ?? "B1";
  const leadHours = Number(arg("--lead") ?? 72);

  const { data: f } = await admin
    .from("florists")
    .select("id, name, email, city_id, lat, lng, source, locale, trust_tier")
    .eq("place_id", "FRTESTSHOP_paris")
    .single();
  if (!f) return console.log("run `shop` first.");

  const src = await sourceOrder();
  const { data: settings } = await admin.from("app_settings").select("default_payout_percent").eq("id", 1).single();
  const pct = settings?.default_payout_percent ?? 55;
  const total = src.total;
  const deliveryAt = new Date(Date.now() + leadHours * H);
  const marker = `${MARKER}${label}`;

  const { data: order, error } = await admin
    .from("orders")
    .insert({
      shopify_order_id: marker,
      order_name: `#${marker}`,
      shopify_created_at: new Date().toISOString(),
      currency: src.currency ?? "EUR",
      total,
      shipping_total: src.shipping_total,
      financial_status: "paid",
      locale: "fr",
      city_id: f.city_id,
      buyer_name: "Test Buyer",
      buyer_email: process.env.FRANCE_E2E_BUYER ?? "owner@fc.example.com",
      recipient_name: "Test Recipient",
      recipient_phone: "+33600000000",
      // ~1km from the shop, well inside its 20km radius and the 20km ring cap.
      delivery_address: { line1: "3 Rue du Temple", line2: null, city: "Paris", postal: "75004", region: "Île-de-France", country: "FR" },
      delivery_area: "Paris · Île-de-France",
      delivery_lat: 48.8580, delivery_lng: 2.3550,
      delivery_at: deliveryAt.toISOString(),
      occasion: "birthday",
      greeting: "Joyeux anniversaire !",
      status: "received",
      notes: `FRANCE E2E ${label} — florist half, pinned to ${f.name}.`,
      worklist_at: new Date().toISOString(),
      worklist_by: ACTOR,
      tags: "QA-AUTO",
      is_demo: false,
      raw: { synthetic: true, scenario: label, pinned_florist: f.id },
    })
    .select("id, order_name, total, delivery_at")
    .single();
  if (error) return console.log(`insert failed: ${error.message}`);

  const { data: items } = await admin.from("order_line_items").select("*").eq("order_id", src.id);
  if (items?.length) {
    await admin.from("order_line_items").insert(items.map(({ id, order_id, created_at, ...r }) => ({ ...r, order_id: order.id })));
  }

  // Mirrors ingest-worker/src/db.ts::insertCandidates for a first match.
  const payout = Math.floor((Math.round(total * 100) * pct) / 10000 + 0.000001);
  const { error: aerr } = await admin.from("order_assignments").insert({
    order_id: order.id,
    florist_id: f.id,
    rank: 1,
    florist_source: f.source,
    status: "candidate",
    offer_kind: "exclusive",
    sla_deadline_at: new Date(new Date(order.delivery_at).getTime() - 2 * H).toISOString(),
    payout_price: payout,
    payout_percent: pct,
    offer_audience: "network",
  });
  if (aerr) return console.log(`assignment failed: ${aerr.message}`);

  await admin.from("orders").update({ status: "matched" }).eq("id", order.id);
  await admin.from("order_events").insert({
    order_id: order.id, type: "matched",
    payload: { france_e2e: label, pinned: f.name, candidates: 1 }, actor: "system",
  });
  console.log(`${label}  ${order.order_name}  → ${f.name}  payout €${payout} @${pct}%  tier ${f.trust_tier}  lead ${leadHours}h`);
  console.log(`   the cron will send the offer to ${f.email} within a minute — with a REAL magic link (is_test_shop exemption).`);
}

const RUN = { seed, watch, clean, settings, compress, shop, passb };
if (!RUN[cmd]) {
  console.error(`unknown command "${cmd}" — use: settings | seed | watch | clean`);
  process.exit(2);
}
await RUN[cmd]();
