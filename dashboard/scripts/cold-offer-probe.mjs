// Why do cold offers stop for a human, and what would it take to stop stopping?
//
//   node scripts/cold-offer-probe.mjs           # diagnose only
//   node scripts/cold-offer-probe.mjs --seed    # also seed an order built to pass
//
// THE PROBLEM THIS ANSWERS. When the wave engine refuses to send a cold offer it
// files an `order_approvals` row instead — and that row records the draft email
// and nothing else (lib/waves.ts, the `kind: "offer"` insert). The reason is
// computed by coldOfferBlockReason() and then discarded, so "37% of orders never
// got an offer sent" cannot be broken down into WHY, and there is no way to tell
// which setting would move it. This script recomputes the same verdict, with the
// same pure function the engine uses, across every shop we hold.
//
// It is a diagnostic, not a fix. The fix is to store the reason on the approval.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { coldOfferBlockReason, COLD_OFFER_MIN_LEAD_HOURS } from "../lib/coldOffer.ts";

const seed = process.argv.includes("--seed");

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
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: settings } = await db
  .from("app_settings")
  .select("cold_offer_enabled, cold_offer_max_payout_eur, default_payout_percent, workflow_mode, offer_window_far_min")
  .eq("id", 1)
  .single();

console.log(`cold offers: ${settings.cold_offer_enabled ? "ON" : "OFF"}   ceiling: €${settings.cold_offer_max_payout_eur}   minimum lead: ${COLD_OFFER_MIN_LEAD_HOURS}h (hard-coded)   mode: ${settings.workflow_mode}`);

// The order we are testing against: far enough out to clear the lead-time gate
// AND to earn the long response window (>72h is the only tier not set to a
// minute on this project), and cheap enough to clear the payout ceiling.
const DELIVERY = new Date(Date.now() + 4 * 24 * 3600e3).toISOString();
const TOTAL = 150;
const PAYOUT = Math.round(TOTAL * ((settings.default_payout_percent ?? 55) / 100) * 100) / 100;
console.log(`test order: €${TOTAL} total → €${PAYOUT} payout, delivering in 96h\n`);

const { data: city } = await db.from("cities").select("id, city, country").ilike("city", "Palma").limit(1).single();
const { data: shops } = await db
  .from("florists")
  .select("id, name, email, joined_at, excluded_at, deleted_at, lifecycle_stage, order_emails_opt_out, lat, lng, phone_maps, phone_web")
  .eq("city_id", city.id);

const order = { payoutEur: PAYOUT, deliveryAt: DELIVERY };
const now = Date.now();
const tally = new Map();
const passing = [];
for (const f of shops ?? []) {
  const reason = coldOfferBlockReason(f, order, settings, now);
  const key = reason ?? "PASSES — would be emailed automatically";
  tally.set(key, (tally.get(key) ?? 0) + 1);
  if (!reason) passing.push(f);
}

console.log(`${city.city}, ${city.country} — ${shops.length} shops, judged by the engine's own rule:\n`);
for (const [reason, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = Math.round((n / shops.length) * 100);
  console.log(`  ${String(n).padStart(4)}  ${String(pct + "%").padStart(4)}  ${reason}`);
}

console.log(`\n→ ${passing.length} of ${shops.length} would go out WITHOUT a human touching them.`);
if (!passing.length) {
  console.log("  Nothing passes. No settings change reaches this — the blockers above are per-shop facts.");
  process.exitCode = 0;
}

if (!seed || !passing.length) {
  if (!seed) console.log("\nRe-run with --seed to create an order for the passing shops and watch it send.");
} else {
  // Seeded as `matched` with candidates already written, because nothing in the
  // system matches an order except the Shopify webhook — see the placement test.
  // The point here is the COLD-OFFER GATE, not the matcher, so the candidates are
  // written directly and the wave engine is left to make the send/approve call.
  const name = "#FIND-09";
  await db.from("orders").delete().eq("order_name", name);
  const { data: o, error } = await db
    .from("orders")
    .insert({
      shopify_order_id: `FINDQA-COLD-${Date.now()}`,
      order_name: name,
      shopify_created_at: new Date().toISOString(),
      currency: "EUR",
      total: TOTAL,
      financial_status: "paid",
      buyer_name: "QA Buyer",
      buyer_email: "qa@example.invalid",
      recipient_name: "QA Recipient",
      substitution_policy: "similar_value",
      status: "matched",
      delivery_at: DELIVERY,
      delivery_area: `${city.city} · ${city.country}`,
      city_id: city.id,
      delivery_lat: passing[0].lat,
      delivery_lng: passing[0].lng,
      worklist_at: new Date().toISOString(),
      notes: "🧪 Cold-offer gate probe — built to pass every gate. Safe to delete.",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const rows = passing.slice(0, 3).map((f, i) => ({
    order_id: o.id,
    florist_id: f.id,
    rank: i + 1,
    status: "candidate",
    offer_kind: "race",
    payout_price: PAYOUT,
    payout_percent: settings.default_payout_percent ?? 55,
    sla_deadline_at: new Date(Date.parse(DELIVERY) - 2 * 3600e3).toISOString(),
  }));
  const { error: aErr } = await db.from("order_assignments").insert(rows);
  if (aErr) throw new Error(aErr.message);

  console.log(`\n✓ seeded ${name} (${o.id}) — matched, ${rows.length} candidates, all of which pass the gate.`);
  console.log(`  Top shop: ${passing[0].name}`);
  console.log(`  The wave engine runs every minute. If the gate works as read, the next tick`);
  console.log(`  EMAILS this shop with no approval filed. Check with:`);
  console.log(`    node scripts/cold-offer-probe.mjs   (re-run) or check-placement-test.mjs`);
}
