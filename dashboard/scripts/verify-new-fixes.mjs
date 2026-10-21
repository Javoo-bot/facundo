// Prove the two behaviours shipped today actually happen on staging, rather
// than trusting the unit tests and the diff.
//
//   node scripts/verify-new-fixes.mjs --seed    # create the two orders
//   node scripts/verify-new-fixes.mjs           # read the verdicts (safe to poll)
//
// Seeding and reading are separate on purpose: a polling loop that also re-seeds
// resets the very state it is waiting for, and waits forever.
//
// Both are things the wave engine does unattended, so this seeds the exact
// state each one reacts to and then waits for a tick to act:
//
//   #FIX-BLOCK   a cold shop that FAILS a gate. The engine should file an offer
//                approval carrying WHY — the thing that used to be computed and
//                thrown away. Delivery is 4h out, so the reason should be
//                `too-urgent` (COLD_OFFER_MIN_LEAD_HOURS is 6).
//
//   #FIX-RELEASE an accepted order whose fulfilment SLA has already passed, with
//                nobody else to hand it to. The engine should escalate the ORDER
//                and — new — close the ASSIGNMENT as `released`, so the florist
//                app stops showing an order we have taken away from them.
//
// Safe: prefixed rows only, payments paused, test mode on.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { coldOfferBlockReason } from "../lib/coldOffer.ts";

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
const seed = process.argv.includes("--seed");

const { data: settings } = await db
  .from("app_settings")
  .select("cold_offer_enabled, cold_offer_max_payout_eur, default_payout_percent, workflow_mode, test_mode, payments_paused")
  .eq("id", 1)
  .single();
if (settings.test_mode !== true || settings.workflow_mode !== "auto") {
  console.error("Needs test_mode on and workflow_mode=auto.");
  process.exit(1);
}
console.log(`mode=${settings.workflow_mode} payments ${settings.payments_paused ? "paused" : "LIVE"}\n`);

const PCT = settings.default_payout_percent ?? 55;
const PAYOUT = Math.round(150 * (PCT / 100) * 100) / 100;

async function clean(name) {
  const { data } = await db.from("orders").select("id").eq("order_name", name);
  for (const o of data ?? []) {
    await db.from("order_approvals").delete().eq("order_id", o.id);
    await db.from("orders").delete().eq("id", o.id);
  }
}

async function makeOrder(name, shop, deliveryAt, status, note) {
  await clean(name);
  const { data: o, error } = await db.from("orders").insert({
    shopify_order_id: `FIXQA-${name.replace(/\W/g, "")}-${Date.now()}`,
    order_name: name,
    shopify_created_at: new Date().toISOString(),
    currency: "EUR", total: 150, financial_status: "paid",
    buyer_name: "QA Buyer", buyer_email: "qa@example.invalid", recipient_name: "Ana Ruiz",
    delivery_lat: shop.lat, delivery_lng: shop.lng,
    delivery_area: "QA fix check", delivery_at: deliveryAt,
    substitution_policy: "similar_value", status,
    worklist_at: new Date().toISOString(),
    notes: `🧪 ${note} Safe to delete.`,
    ...(shop.city_id ? { city_id: shop.city_id } : {}),
  }).select("id").single();
  if (error) throw new Error(`${name}: ${error.message}`);
  return o.id;
}

if (seed) {
// ── #FIX-BLOCK — a cold shop that fails a gate ─────────────────────────────
const soon = new Date(Date.now() + 4 * 3600e3).toISOString(); // inside the 6h minimum
const { data: coldPool } = await db.from("florists")
  .select("id, name, city_id, lat, lng, email, joined_at, excluded_at, deleted_at, lifecycle_stage, order_emails_opt_out")
  .is("joined_at", null).not("email", "is", null).not("lat", "is", null)
  .is("excluded_at", null).is("deleted_at", null).limit(50);
const coldShop = (coldPool ?? []).find((f) =>
  coldOfferBlockReason(f, { payoutEur: PAYOUT, deliveryAt: soon }, settings, Date.now()) === "too-urgent");
if (!coldShop) {
  console.error("No cold shop whose only failing gate is the lead time — cannot isolate the reason.");
} else {
  const id = await makeOrder("#FIX-BLOCK", coldShop, soon, "matched", "Cold gate should refuse with a recorded reason.");
  await db.from("order_assignments").insert({
    order_id: id, florist_id: coldShop.id, rank: 1, status: "candidate", offer_kind: "race",
    payout_price: PAYOUT, payout_percent: PCT,
  });
  console.log(`#FIX-BLOCK   ${coldShop.name} — delivery in 4h, expect approval with block_reason="too-urgent"`);
}

// ── #FIX-RELEASE — accepted, stalled, nobody to hand it to ─────────────────
const near = new Date(Date.now() + 3 * 3600e3).toISOString();
const holder = (coldPool ?? [])[0];
{
  const id = await makeOrder("#FIX-RELEASE", holder, near, "accepted", "Stalled accept; assignment should be released.");
  await db.from("order_assignments").insert({
    order_id: id, florist_id: holder.id, rank: 1, status: "accepted", offer_kind: "race",
    payout_price: PAYOUT, payout_percent: PCT,
    // Already past, so the fulfilment sweep fires on the next tick. No other
    // candidate exists, so reassignOrder has nowhere to go and we hit the
    // escalate-and-release branch.
    sla_deadline_at: new Date(Date.now() - 30 * 60e3).toISOString(),
    accepted_at: new Date(Date.now() - 40 * 60e3).toISOString(),
    sent_at: new Date(Date.now() - 60 * 60e3).toISOString(),
  });
  console.log(`#FIX-RELEASE ${holder.name} — accepted with a breached SLA, expect order=escalated AND assignment=released`);
}

console.log(`\nThe wave runs every minute. Re-run this script to read the verdicts.\n`);


}
// ── verdicts ───────────────────────────────────────────────────────────────
for (const name of ["#FIX-BLOCK", "#FIX-RELEASE"]) {
  const { data: o } = await db.from("orders").select("id, status, escalation_reason").eq("order_name", name).maybeSingle();
  if (!o) continue;
  const { data: a } = await db.from("order_assignments").select("status").eq("order_id", o.id);
  const { data: ap } = await db.from("order_approvals").select("kind, status, block_reason").eq("order_id", o.id);
  console.log(`${name}: order=${o.status}${o.escalation_reason ? `(${o.escalation_reason})` : ""} assignments=${(a ?? []).map((x) => x.status).join(",") || "none"}`);
  for (const r of ap ?? []) console.log(`   approval ${r.kind}/${r.status} block_reason=${r.block_reason ?? "(null)"}`);
}
