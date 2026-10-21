// Put the "Contact a florist" row on /operator, and a call card behind it that
// an operator can actually finish.
//
//   node scripts/seed-operator-call-case.mjs          # create it
//   node scripts/seed-operator-call-case.mjs --clean  # delete it again
//
// WHY A SCRIPT AND NOT A CODE CHANGE. The case already exists end to end:
// cxAttention.ts rule 2 emits "Offer stalling — SLA breached", lib/operator.ts
// turns that into the headline "No florist has answered yet" and the button
// "Contact a florist", and it is the ONE action that routes off the order page
// — to /orders/[id]/call, the card built for this exact call. Nothing was
// missing except an order in that state: staging had a single live offer and
// its SLA had not passed, so the row had nothing to render from.
//
// THE STATE THE OPERATOR ROW NEEDS, which is the first half of this script:
//   * an order in `reaching_out` (so cxAttention's `reachingOrders` query sees
//     it and can name it — an order none of its three order queries returns is
//     dropped even when an assignment would have flagged it);
//   * IN THE WORKING SET — `worklist_at` is set explicitly, so the row survives
//     whatever `app_settings.active_order_tags` happens to be;
//   * one assignment in `sent` (cxAttention's LIVE_OFFER = sent|opened) whose
//     `sla_deadline_at` is already past. That is the trigger, and nothing else
//     is.
// The two `expired` assignments are not part of the trigger. They are there so
// the row's context line has something true to say ("3 shops asked, none
// replied") instead of "no shop contacted yet", which is the line for an order
// nobody has touched and would misdescribe this one.
//
// WHY THE FIXTURE OWNS ITS SHOPS, which is the second half. The call card is
// the destination, and every word on it is read off the florist row. A shop
// with the columns empty renders a card that cannot be worked:
//
//   phone_maps / phone_web  THE HARD ONE. lib/callCardData.ts::loadOrderCallData
//                           builds the subject's number as
//                           normalisePhone(phone_maps, phone_web) — phone_mobile
//                           is NOT read. With both empty the card shows
//                           uncallableReason()'s red "No phone number on file
//                           for this shop." and the whole "How did it go?"
//                           control never mounts (CallCard.tsx gates it on
//                           `subject.phone && canAct`), so THE OUTCOME CANNOT BE
//                           RECORDED AT ALL. The first cut of this fixture chose
//                           its shops on any of the three phone columns and hit
//                           exactly that.
//   owner_name              Without it the card says "No contact name on file —
//                           ask who handles the orders."
//   rating / review_count   The whole shop-facts line is dropped when both are
//                           null.
//   lat / lng               Distance is haversine against the ORDER's
//                           delivery_lat/lng, so both ends are needed — hence
//                           the coordinates on the order below.
//   lifecycle_stage         'production' reads "In the network"; anything else
//                           reads "Cold lead · never worked with us".
//
// The shops are created rather than borrowed: the `is_test_shop` shops already
// on staging belong to other people's fixtures, and filling in their blank
// columns to make this card look good would be editing someone else's test
// data.
//
// SAFETY. Orders are named `#CALL-…` and shops carry place_id `CALLDEMO_…`;
// --clean deletes on those two markers only. It refuses to run unless
// `app_settings.test_mode` is on. The shops are `is_test_shop` with
// app_settings.test_email as their address, so anything that ever does mail
// them mails the staff sink. They are deliberately NOT excluded/soft-deleted:
// the point of the card is that its three outcomes work, and "Accepted" runs
// the real /api/orders/reachout accept — payout leg, comms and all — which
// should meet an ordinary shop, not a hidden one.
//
// ONE THING TO EXPECT. An order in the working set is one the real automation
// works: the offer-wave cron may expire this breached offer and move to the
// next shop, which retires the row. That is the system behaving correctly, not
// the fixture breaking — re-run the script to get it back.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PREFIX = "#CALL-";
const SHOP_PREFIX = "CALLDEMO_";
const clean = process.argv.includes("--clean");

// -- credentials ------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
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
console.log(`-> ${url.replace(/https:\/\/([a-z]{6}).*/, "https://$1....supabase.co")}`);

const die = (msg) => { console.error(msg); process.exit(1); };

// -- guard: staging only ----------------------------------------------------
const { data: settings, error: sErr } = await db
  .from("app_settings")
  .select("test_mode, test_email")
  .eq("id", 1)
  .maybeSingle();
if (sErr) die(`Could not read app_settings: ${sErr.message}`);
if (settings?.test_mode !== true) {
  die("REFUSING TO RUN: app_settings.test_mode is not true. This script is for staging only.");
}
if (!settings.test_email) {
  die("REFUSING TO RUN: app_settings.test_email is unset, so the fixture shops have no sink address to use.");
}

// -- clean ------------------------------------------------------------------
// Orders first: order_assignments cascade from the order, and deleting a
// florist that still has assignments would fail on the FK.
{
  const { data: orders } = await db.from("orders").select("id").like("order_name", `${PREFIX}%`);
  const ids = (orders ?? []).map((o) => o.id);
  if (ids.length) {
    const { error } = await db.from("orders").delete().in("id", ids);
    if (error) die(`Could not remove previous ${PREFIX} orders: ${error.message}`);
    console.log(`  removed ${ids.length} previous ${PREFIX} order(s)`);
  }
  const { data: shops } = await db.from("florists").select("id").like("place_id", `${SHOP_PREFIX}%`);
  if (shops?.length) {
    const { error } = await db.from("florists").delete().like("place_id", `${SHOP_PREFIX}%`);
    if (error) die(`Could not remove previous fixture shops: ${error.message}`);
    console.log(`  removed ${shops.length} previous fixture shop(s)`);
  }
}
if (clean) {
  console.log("  clean: done");
  process.exit(0);
}

// -- the shops --------------------------------------------------------------
// Girona, because the order below is delivering there and the card prints the
// distance between the two. Real coordinates, a real spread — 1.2 km, 3.4 km
// and 6.9 km out — so "closest first" on the card means something.
const DELIVERY = { lat: 41.9794, lng: 2.8214 };

const SHOPS = [
  {
    name: "Floristeria Pont de Pedra",
    owner_name: "Núria Bonet",
    phone: "+34 972 00 03 03",
    address: "Carrer de Santa Clara 12, 17001 Girona",
    rating: 4.7,
    review_count: 312,
    lat: 41.9836,
    lng: 2.8231,
    stage: "production",
  },
  {
    name: "Flors i Plantes Devesa",
    owner_name: "Marc Vidal",
    phone: "+34 972 00 03 02",
    address: "Passeig de la Devesa 44, 17001 Girona",
    rating: 4.4,
    review_count: 128,
    lat: 42.0021,
    lng: 2.8309,
    stage: "production",
  },
  {
    name: "Roser Flors Salt",
    owner_name: "Anna Puig",
    phone: "+34 972 00 03 01",
    address: "Carrer Major 7, 17190 Salt",
    rating: 4.1,
    review_count: 64,
    lat: 41.9743,
    lng: 2.7395,
    stage: "production",
  },
];

// Girona already exists as a real ingested city; hang the shops off it rather
// than inventing a second one, so the pair reads as one market.
const { data: city } = await db
  .from("cities")
  .select("id")
  .eq("country", "ES")
  .eq("city", "Girona")
  .maybeSingle();
if (!city) die("No Girona city row on this project — the fixture shops need a city to hang off.");

const { data: shops, error: fErr } = await db
  .from("florists")
  .insert(
    SHOPS.map((s, i) => ({
      city_id: city.id,
      place_id: `${SHOP_PREFIX}${String(i + 1).padStart(2, "0")}`,
      name: s.name,
      address: s.address,
      lat: s.lat,
      lng: s.lng,
      rating: s.rating,
      review_count: s.review_count,
      // BOTH phone columns, because loadOrderCallData reads phone_maps first
      // and falls back to phone_web — and only those two.
      phone_maps: s.phone,
      phone_web: s.phone,
      phone_mobile: s.phone,
      owner_name: s.owner_name,
      // Every fixture shop answers to the staff sink, so nothing here can mail
      // a stranger even if automation reaches it.
      email: settings.test_email,
      has_website: true,
      is_test_shop: true,
      lifecycle_stage: s.stage,
      joined_at: new Date(Date.now() - (30 + i * 15) * 86400_000).toISOString(),
      enrichment_notes: "Fixture shop from scripts/seed-operator-call-case.mjs - not a real shop.",
    }))
  )
  .select("id, name");
if (fErr) die(`Could not create the fixture shops: ${fErr.message}`);

// -- the order --------------------------------------------------------------
const now = Date.now();
const at = (mins) => new Date(now + mins * 60_000).toISOString();

const { data: order, error: oErr } = await db
  .from("orders")
  .insert({
    shopify_order_id: `CALL-${now}`,
    order_name: `${PREFIX}01`,
    shopify_created_at: new Date(now - 3 * 3600_000).toISOString(),
    // `reaching_out` is load-bearing, see the header. An escalated or matched
    // order would be picked up by rule 1 instead and render a "place this"
    // button, which is a different row entirely.
    status: "reaching_out",
    // Inside two hours, so the row wears the critical tone and sorts to the top
    // of the deadline order the page uses. Far enough out that it is not ALSO
    // past its delivery deadline, which would be a second, louder reason.
    delivery_at: at(45),
    delivery_window: "17:00-19:00",
    delivery_area: "Girona · Catalunya",
    delivery_address: { line1: "Carrer del Carme 24", city: "Girona", postal: "17004", region: "Catalunya", country: "ES" },
    // Both ends of the haversine — without these the card's "x km from the
    // delivery address" is silently dropped.
    delivery_lat: DELIVERY.lat,
    delivery_lng: DELIVERY.lng,
    city_id: city.id,
    currency: "EUR",
    total: 74.9,
    financial_status: "paid",
    buyer_name: "QA Buyer",
    buyer_email: "qa@example.invalid",
    recipient_name: "Marta Serra",
    substitution_policy: "similar_value",
    notes: "Operator-panel fixture for the 'Contact a florist' row. Safe to delete.",
    // Explicit working-set pick, so the row appears whatever the tag gate says
    // (lib/workingSet.ts::isInWorkingSet).
    worklist_at: new Date(now).toISOString(),
  })
  .select("id, order_name")
  .single();
if (oErr) die(`Could not create the order: ${oErr.message}`);

// Something for the card to name under "What they were offered".
const { error: liErr } = await db.from("order_line_items").insert({
  order_id: order.id,
  title: "Bouquet of 24 red roses",
  variant: "Large, with vase",
  quantity: 1,
  unit_price: 74.9,
  line_total: 74.9,
  product_type: "bouquet",
});
if (liErr) console.warn(`  (line item skipped: ${liErr.message})`);

// rank 1 is THE trigger: live (`sent`) with an SLA that passed 20 minutes ago.
// It is also the shop pickSubject lands on, so the closest, best-rated one goes
// first. The other two are history, and `expired` rather than `declined` on
// purpose — a declined shop is one that answered, and this row is about silence.
const offers = [
  { status: "sent", slaMins: -20 },
  { status: "expired", slaMins: -95 },
  { status: "expired", slaMins: -160 },
];
const { error: aErr } = await db.from("order_assignments").insert(
  offers.map((o, i) => ({
    order_id: order.id,
    florist_id: shops[i % shops.length].id,
    rank: i + 1,
    status: o.status,
    offer_kind: "race",
    payout_price: 52.43,
    sent_at: new Date(now - (i + 1) * 40 * 60_000).toISOString(),
    sla_deadline_at: at(o.slaMins),
  }))
);
if (aErr) die(`Could not create the offers: ${aErr.message}`);

console.log(`  ${shops.length} fixture shops created (${shops.map((s) => s.name).join(", ")})`);
console.log(`  ${order.order_name} created — offer to "${shops[0].name}", SLA breached 20 min ago`);
console.log(`\n  /operator row:`);
console.log(`     44 MIN LEFT   No florist has answered yet`);
console.log(`                   ${order.order_name} · Girona, ES · 3 shops asked, none replied   [ Contact a florist ]`);
console.log(`\n  /orders/${order.id}/call — the card should show the number, "Ask for ${SHOPS[0].owner_name}."`);
console.log(`  and a "How did it go?" selector with Accepted / Refused / No answer.\n`);
