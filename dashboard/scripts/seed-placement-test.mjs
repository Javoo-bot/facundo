// Seed the staging database with the orders needed to walk the FIND-A-FLORIST
// half of the Operator flow end to end, and find out where it breaks.
//
//   node scripts/seed-placement-test.mjs          # create them
//   node scripts/seed-placement-test.mjs --clean  # delete them again
//
// WHY THIS IS NOT seed-operator-demo.mjs. That script seeds one order per
// SENTENCE the Operator panel can say — it is a copy fixture, and its orders
// are inert: hand-written statuses, assignments that were never really offered,
// nothing for the wave engine to do. This one is the opposite. Half of these
// orders are seeded with NOTHING but a delivery address and a deadline, so the
// real matcher, the real cold-offer gate and the real wave engine have to
// place them, and we find out what actually happens. The other half are staged
// directly onto a specific Operator row, so the screens downstream of a stuck
// order can be exercised without waiting for one to occur naturally.
//
// SAFETY. Every row is named `#FIND-…` and --clean deletes on that prefix only.
// It refuses to run unless `test_mode` is on, and refuses to run while
// `payments_live` is on — see the preflight below for why that second one
// matters more here than it did for the demo fixture.
//
// The deadlines are computed at seed time, never hard-coded. The demo fixture
// aged out (its "2 hours from now" orders were hours PAST their deadline by the
// time anyone tested), and a past-deadline order is not merely a stale fixture:
// waves.ts refuses to refill or offer one at all and re-escalates it as
// `past_delivery_deadline`, so every scenario would report the same wrong
// answer. Re-run this script rather than testing against yesterday's rows.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { coldOfferBlockReason } from "../lib/coldOffer.ts";

const PREFIX = "#FIND-";
const clean = process.argv.includes("--clean");
// Escape hatch for the payments guard below. Deliberately ugly to type.
const paymentsLiveOk = process.argv.includes("--payments-live-ok");

// ── credentials ────────────────────────────────────────────────────────────
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

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
console.log(`→ ${url.replace(/https:\/\/([a-z]{6}).*/, "https://$1….supabase.co")}`);

// ── preflight ──────────────────────────────────────────────────────────────
const { data: settings, error: sErr } = await db
  .from("app_settings")
  .select("test_mode, payments_live, payments_paused, workflow_mode, test_email, test_phone, cold_offer_enabled, cold_offer_max_payout_eur, offer_window_rush_min, offer_window_sameday_min, offer_window_standard_min, offer_window_far_min, active_order_tags")
  .eq("id", 1)
  .single();
if (sErr) {
  console.error("Could not read app_settings:", sErr.message);
  process.exit(1);
}

if (settings.test_mode !== true) {
  console.error("REFUSING TO RUN: app_settings.test_mode is not true. This script is for staging only.");
  process.exit(1);
}

// The demo fixture does not need this check, because none of its orders is ever
// really accepted. This one exists to be driven to an ACCEPT, and the payout
// rail does not consult test_mode at all: lib/payout.ts reads `payments_live`,
// `payments_paused` and `florists.is_test_shop`, nothing else. So accepting on
// a real scraped florist with payments live and unpaused issues a REAL payout
// leg — and under cold_offer_auto_payout_cap_eur it releases immediately rather
// than parking for review.
//
// EITHER of two things makes that impossible, and the kill switch is the one to
// reach for: `payments_paused` short-circuits issueLeg before any card is cut
// (lib/payout.ts::issueLeg returns none("paused")), which is Settings →
// Payments → "Pause all payments (kill switch)". `payments_live` off is the
// other way, but it is not exposed in that panel.
const paymentsSafe = settings.payments_paused === true || settings.payments_live !== true;
if (!paymentsSafe && !clean && !paymentsLiveOk) {
  console.error("");
  console.error("REFUSING TO RUN: payments are live and not paused.");
  console.error("");
  console.error("  test_mode redirects EMAIL to the test inbox. It does not touch payouts.");
  console.error("  Accepting one of these orders on a real shop would issue a real payout leg.");
  console.error("");
  console.error("  FIX: Settings → Payments → tick 'Pause all payments (kill switch)'.");
  console.error("  Untick it when the test is done.");
  console.error("");
  console.error("  Or re-run with --payments-live-ok if you will only ever press Accepted");
  console.error("  on #FIND-07, which uses a shop this script creates and owns.");
  console.error("");
  process.exit(1);
}

console.log(paymentsSafe
  ? `✓ test_mode on, payouts cannot fire (${settings.payments_paused === true ? "payments paused" : "payments not live"}) — safe to seed`
  : "⚠ test_mode on, PAYMENTS CAN FIRE — only accept on #FIND-07, which is our own shop");
console.log(`  workflow_mode=${settings.workflow_mode}  cold_offers=${settings.cold_offer_enabled}  test_email=${settings.test_email ?? "(unset)"}`);

// The offer window is the single setting most likely to make this whole test
// report nonsense, so it is surfaced here rather than left to be discovered.
const w = settings;
if ((w.offer_window_rush_min ?? 0) <= 5 || (w.offer_window_sameday_min ?? 0) <= 5 || (w.offer_window_standard_min ?? 0) <= 5) {
  console.log("");
  console.log(`  ⚠ OFFER WINDOWS ARE ${w.offer_window_rush_min}/${w.offer_window_sameday_min}/${w.offer_window_standard_min}/${w.offer_window_far_min} min (rush/sameday/standard/far).`);
  console.log("    A window under ~5 minutes means every offer lapses before a human could read it:");
  console.log("    the wave engine burns all 12 shops in a few minutes and escalates, and the");
  console.log("    'offer is out, nobody answered' row barely exists long enough to click.");
  console.log("    Scenarios 01-04 will look broken because of this setting, not because of a bug.");
  console.log("");
}

// ── clean ──────────────────────────────────────────────────────────────────
async function removeSeeded() {
  const { data: existing } = await db.from("orders").select("id").like("order_name", `${PREFIX}%`);
  const ids = (existing ?? []).map((o) => o.id);
  if (ids.length) {
    const { data: asg } = await db.from("order_assignments").select("id").in("order_id", ids);
    const asgIds = (asg ?? []).map((a) => a.id);
    if (asgIds.length) {
      const { data: po } = await db.from("payouts").select("id").in("assignment_id", asgIds);
      const poIds = (po ?? []).map((p) => p.id);
      if (poIds.length) await db.from("payment_events").delete().in("payout_id", poIds);
    }
    await db.from("order_approvals").delete().in("order_id", ids);
    await db.from("orders").delete().in("id", ids);
  }
  return ids.length;
}

const removed = await removeSeeded();
if (removed) console.log(`✓ removed ${removed} previously seeded order(s)`);
if (clean) {
  console.log("Done (clean only).");
  process.exit(0);
}

// ── the cities we actually have shops in ───────────────────────────────────
//
// Delivery coordinates are derived from the REAL florists in each city rather
// than typed in, so the matcher's distance rings have something true to work
// against. A hand-picked lat/lng that happens to sit 30km from every shop would
// make a perfectly healthy city look like a coverage hole.
async function cityPoint(cityName) {
  const { data: city } = await db.from("cities").select("id, city, country").ilike("city", cityName).limit(1).maybeSingle();
  if (!city) return null;
  const { data: shops } = await db
    .from("florists")
    .select("lat, lng, email, phone_maps, phone_web")
    .eq("city_id", city.id)
    .is("deleted_at", null)
    .is("excluded_at", null)
    .not("lat", "is", null);
  if (!shops?.length) return null;
  const lat = shops.reduce((s, f) => s + f.lat, 0) / shops.length;
  const lng = shops.reduce((s, f) => s + f.lng, 0) / shops.length;
  return {
    ...city,
    lat,
    lng,
    total: shops.length,
    withEmail: shops.filter((f) => f.email).length,
    withPhone: shops.filter((f) => f.phone_maps || f.phone_web).length,
  };
}

const palma = await cityPoint("Palma");
const york = await cityPoint("York");
if (!palma || !york) {
  console.error("Expected florists in Palma and York on this project; found none. Adjust the city list.");
  process.exit(1);
}
console.log(`✓ Palma: ${palma.total} shops (${palma.withEmail} emailable, ${palma.withPhone} callable)`);
console.log(`✓ York:  ${york.total} shops (${york.withEmail} emailable, ${york.withPhone} callable)`);

// ── the shop the accept scenario runs against ──────────────────────────────
//
// NOT an `is_test_shop` florist. `test_shop_matching` is "exclude" on this
// project, so one would never match anything, and the point of the exercise is
// to watch the real matcher work. A real scraped Palma shop is used instead.
//
// That is safe here for two independent reasons, and it is worth being precise
// about which is doing the work:
//   - EMAIL: test_mode redirects every offer to a non-test shop to
//     app_settings.test_email (lib/offerVars.ts: redirectToTestInbox =
//     testMode && !testShop). The florist's own address is never written to.
//   - MONEY: payments are PAUSED, so lib/payout.ts::issueLeg returns
//     none("paused") before any card is cut. The preflight above refuses to run
//     otherwise.
// The shop is therefore never contacted and never paid, but every code path
// runs exactly as it would in production.

// A real, callable shop for the scenarios that rehearse phoning someone who
// genuinely exists. Chosen from York, where almost nothing has an email and the
// phone is the only channel — the situation this whole exercise is about.
const { data: callablePalma } = await db
  .from("florists")
  .select("id, name, phone_maps, phone_web, email")
  .eq("city_id", palma.id)
  .is("deleted_at", null)
  .is("excluded_at", null)
  .not("email", "is", null)
  .or("phone_maps.not.is.null,phone_web.not.is.null")
  .limit(4);

const { data: callableYork } = await db
  .from("florists")
  .select("id, name, phone_maps, phone_web, email")
  .eq("city_id", york.id)
  .is("deleted_at", null)
  .or("phone_maps.not.is.null,phone_web.not.is.null")
  .limit(4);

// ── helpers ────────────────────────────────────────────────────────────────
const now = Date.now();
const at = (mins) => new Date(now + mins * 60_000).toISOString();
const hours = (n) => at(n * 60 + 5);
const days = (n) => at(n * 24 * 60);

let seq = 0;
const plan = [];

async function makeOrder({ label, expect, click, city, total = 74.9, ...fields }) {
  seq += 1;
  const name = `${PREFIX}${String(seq).padStart(2, "0")}`;
  const { data, error } = await db
    .from("orders")
    .insert({
      shopify_order_id: `FINDQA-${now}-${seq}`,
      order_name: name,
      shopify_created_at: new Date(now - 30 * 60_000).toISOString(),
      currency: "EUR",
      total,
      financial_status: "paid",
      buyer_name: "QA Buyer",
      buyer_email: "qa@example.invalid",
      recipient_name: "QA Recipient",
      substitution_policy: "similar_value",
      notes: `🧪 Placement test — ${label}. Safe to delete.`,
      // Explicit working-set pick. active_order_tags is currently ["QA-AUTO"],
      // and an order outside the working set is never auto-matched, offered or
      // escalated — it would sit inert and read as a broken scenario.
      worklist_at: new Date().toISOString(),
      ...(city ? { delivery_area: `${city.city} · ${city.country}`, city_id: city.id, delivery_lat: city.lat, delivery_lng: city.lng } : {}),
      ...fields,
    })
    .select("id, order_name")
    .single();
  if (error) throw new Error(`${name}: ${error.message}`);
  plan.push({ name, label, expect, click });
  return data;
}

/**
 * Shops near a delivery point that the engine could actually be asked to offer.
 *
 * Group A used to be seeded at `received` with no candidates, on the assumption
 * that something would match them. Nothing does: matching runs on the Shopify
 * webhook, and a row inserted straight into the table never had one. All five
 * sat untouched forever and read as a routing failure — a gap the FIXTURE
 * invented. They now start where a real order starts once its webhook has been
 * handled: `matched`, with candidates written.
 *
 * The picks are judged by the engine's own coldOfferBlockReason so a scenario
 * that is supposed to test the gate tests the gate, rather than tripping over
 * an unrelated one. `want` selects which verdict this scenario needs.
 */
async function nearbyShops(lat, lng, deliveryAt, payout, want, limit = 3) {
  const box = 0.35; // ~35km, wider than the 20km cap so the gate does the deciding
  const { data } = await db
    .from("florists")
    .select("id, name, email, joined_at, excluded_at, deleted_at, lifecycle_stage, order_emails_opt_out, lat, lng")
    .gte("lat", lat - box).lte("lat", lat + box)
    .gte("lng", lng - box).lte("lng", lng + box)
    .is("deleted_at", null).is("excluded_at", null)
    .limit(300);
  const now = Date.now();
  const judged = (data ?? []).map((f) => ({
    f,
    reason: coldOfferBlockReason(f, { payoutEur: payout, deliveryAt }, settings, now),
  }));
  const matching = want === "any" ? judged : judged.filter((j) => j.reason === want);
  return matching.slice(0, limit).map((j) => j.f);
}

async function addCandidates(orderId, shops, payout, deliveryAt) {
  if (!shops.length) return 0;
  const { error } = await db.from("order_assignments").insert(shops.map((f, i) => ({
    order_id: orderId, florist_id: f.id, rank: i + 1,
    status: "candidate", offer_kind: "race",
    payout_price: payout, payout_percent: 55,
    sla_deadline_at: deliveryAt ? new Date(Date.parse(deliveryAt) - 2 * 3600e3).toISOString() : null,
  })));
  if (error) throw new Error(`candidates: ${error.message}`);
  return shops.length;
}

async function addAssignments(orderId, specs) {
  const rows = specs.map((s, i) => ({
    order_id: orderId,
    florist_id: s.floristId,
    rank: i + 1,
    status: s.status,
    offer_kind: "race",
    payout_price: 41.2,
    payout_percent: 55,
    sent_at: s.status === "candidate" ? null : new Date(now - 45 * 60_000).toISOString(),
    sla_deadline_at: s.slaMins != null ? at(s.slaMins) : null,
    offer_expires_at: s.expiresMins != null ? at(s.expiresMins) : null,
    declined_at: s.status === "declined" ? new Date(now - 20 * 60_000).toISOString() : null,
    decline_reason: s.status === "declined" ? "Too busy" : null,
  }));
  const { error } = await db.from("order_assignments").insert(rows);
  if (error) throw new Error(`assignments: ${error.message}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP A — nothing is staged. The real matcher and wave engine must place
// these, and what they do is the finding.
// ═══════════════════════════════════════════════════════════════════════════

{
  const deliveryAt = days(5);
  const o = await makeOrder({
    label: "Normal city, shops that clear every gate",
    city: palma, delivery_at: deliveryAt, status: "matched",
    expect: "Cold offers pass, so the wave emails the top shop on the next tick with NO approval filed.",
    click: "Nothing. It should place itself as far as the offer. Accept as the florist to finish it.",
  });
  const shops = await nearbyShops(palma.lat, palma.lng, deliveryAt, 41.2, null);
  await addCandidates(o.id, shops, 41.2, deliveryAt);
}

{
  const deliveryAt = hours(4); // inside COLD_OFFER_MIN_LEAD_HOURS
  const o = await makeOrder({
    label: "Too urgent for a cold offer",
    city: palma, delivery_at: deliveryAt, status: "matched",
    expect: "The gate says too-urgent, so auto mode files an approval instead of sending — and now records that reason on it.",
    click: "Approve the offer, from the row. Check the approval carries block_reason=too-urgent.",
  });
  const shops = await nearbyShops(palma.lat, palma.lng, deliveryAt, 41.2, "too-urgent");
  await addCandidates(o.id, shops, 41.2, deliveryAt);
}

{
  const deliveryAt = days(5);
  const o = await makeOrder({
    label: "Payout over the cold-offer ceiling",
    city: palma, total: 400, delivery_at: deliveryAt, status: "matched",
    expect: "Payout is 55% = 220 EUR, over the 120 EUR ceiling, so the gate says payout-too-high and an approval is filed.",
    click: "Approve the offer — same row as the last one, completely different reason. The reason is now on the approval.",
  });
  const shops = await nearbyShops(palma.lat, palma.lng, deliveryAt, 220, "payout-too-high");
  await addCandidates(o.id, shops, 220, deliveryAt);
}

{
  const deliveryAt = days(5);
  const o = await makeOrder({
    label: "Shops we cannot email",
    city: york, delivery_at: deliveryAt, status: "matched",
    expect: `Across the project 5,423 of 7,697 live shops have no usable address. A cold offer requires one, so these are refused with no-email and handed to a person.`,
    click: "THE QUESTION: with the phone the only channel left, can the desk get to them at all?",
  });
  const shops = await nearbyShops(york.lat, york.lng, deliveryAt, 41.2, "no-email");
  await addCandidates(o.id, shops, 41.2, deliveryAt);
}

await makeOrder({
  label: "Nowhere near a florist",
  delivery_area: "Longyearbyen · Svalbard",
  delivery_lat: 78.22, delivery_lng: 15.63,
  delivery_at: days(4),
  // Seeded already escalated: this is the state the matcher PRODUCES when it
  // finds nobody inside the cap, and the matcher cannot be run from here. The
  // scenario is about what the desk does next, not about the search itself.
  status: "escalated",
  escalation_reason: "pool_exhausted",
  expect: "No shop inside the 20km hard cap.",
  click: "Find a florist → expect the note 'No florist matched within 20km'. The row correctly stays.",
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP B — staged directly onto one Operator row, so the screen downstream
// of it can be exercised now instead of waiting for the state to occur.
// ═══════════════════════════════════════════════════════════════════════════

{
  const shops = (callableYork ?? []).slice(0, 3);
  const o = await makeOrder({
    label: "The list ran out, but the city has not",
    city: york,
    delivery_at: days(3),
    status: "escalated",
    escalation_reason: "candidates_exhausted",
    expect: "Find more florists → adds shops AND returns the order to `matched` (the 21f31d09 fix), so the wave engine picks it up and offers them without anyone else clicking.",
    click: "Find more florists. Then re-run check-placement-test.mjs and confirm the status left `escalated`.",
  });
  if (shops.length) await addAssignments(o.id, shops.map((s) => ({ floristId: s.id, status: "declined" })));
}

{
  const o = await makeOrder({
    label: "Offer out, nobody answered — the phone call",
    city: palma,
    delivery_at: hours(3),
    status: "reaching_out",
    expect: "The one row that routes to the call screen. Its SLA (delivery − 2h) is already past and the offer is still live.",
    click: "Contact a florist → the call card → try all three outcomes. Accepted is safe: payments are paused, and the offer email went to the test inbox, not the shop.",
  });
  const shop = (callablePalma ?? [])[0];
  if (!shop) throw new Error("No Palma shop with both an email and a phone — pick another city for scenario 07.");
  await addAssignments(o.id, [
    { floristId: shop.id, status: "sent", slaMins: -25, expiresMins: 120 },
  ]);
  console.log(`  07 will call: ${shop.name} (${shop.phone_maps ?? shop.phone_web})`);
}

{
  const shops = (callableYork ?? []).slice(0, 3);
  const o = await makeOrder({
    label: "Everyone we asked said no",
    city: york,
    delivery_at: days(2),
    status: "reaching_out",
    expect: "No live offer and every candidate declined. cxAttention calls this 'Needs next florist — no live offer'.",
    click: "Send to another florist → NOTE WHERE IT LANDS. This is the out-of-bounds case: the button opens the old order page.",
  });
  if (shops.length) await addAssignments(o.id, shops.map((s) => ({ floristId: s.id, status: "declined" })));
}

// ── the plan ───────────────────────────────────────────────────────────────
console.log(`\n✓ seeded ${plan.length} orders\n`);
for (const p of plan) {
  console.log(`${p.name}  ${p.label}`);
  console.log(`          expect: ${p.expect}`);
  console.log(`          do:     ${p.click}\n`);
}
console.log("Now: open /operator, work the list top to bottom, and run");
console.log("  node --import ./scripts/alias-loader-register.mjs scripts/check-placement-test.mjs");
console.log("after each click to see what actually moved.\n");
