// The two ways an order can reach a florist, seeded side by side.
//
//   node scripts/seed-two-branches.mjs
//
// The wave engine forks on ONE question — has this shop joined us? — and the two
// answers take completely different routes (lib/waves.ts, the candOnboarded /
// coldOk branch):
//
//   IN THE NETWORK (lifecycle_stage production|onboarding)
//       auto mode sends immediately. No cold-offer gate is consulted at all.
//
//   NEVER JOINED
//       every clause of coldOfferBlockReason() must pass: cold offers enabled,
//       has an email, has coordinates, not opted out, not excluded or lost,
//       payout at or under the ceiling, and at least 6 hours to delivery. Pass
//       them all and it sends unattended; fail any one and a human is asked.
//
// Both orders here are built to travel. That is the point: an order missing a
// field is a gap the FIXTURE invented, and it is indistinguishable from a real
// one until someone reads the code. Concretely, each carries
//
//   · a delivery point taken from the shop itself, so distance rings and the
//     shop's own delivery_radius_km both pass rather than being a coin toss
//   · a payout under app_settings.cold_offer_max_payout_eur
//   · delivery MORE THAN 72 HOURS out — which clears the 6h cold-offer minimum
//     and, on this project, is the only tier whose response window is not one
//     minute, so the offer survives long enough for a person to open it
//   · real line items with prices and an image, because the florist's offer page
//     and the call card both render the bouquet, and an order with none of that
//     looks broken in a way that has nothing to do with the routing
//   · an explicit worklist pick, so the working-set gate cannot silently
//     exclude it
//
// Seeded at `matched` with candidates already written, deliberately: nothing in
// the system matches an order except the Shopify webhook, so a fixture inserted
// straight into the table would sit at `received` forever and look like a
// routing bug. That is a real finding about missed webhooks, recorded elsewhere;
// it is not what these two orders are for.

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

const { data: settings } = await db
  .from("app_settings")
  .select("cold_offer_enabled, cold_offer_max_payout_eur, default_payout_percent, workflow_mode, test_mode, payments_paused")
  .eq("id", 1)
  .single();

if (settings.test_mode !== true) {
  console.error("REFUSING TO RUN: test_mode is off. Staging only.");
  process.exit(1);
}
if (settings.workflow_mode !== "auto") {
  console.error(`REFUSING TO RUN: workflow_mode is "${settings.workflow_mode}". Neither branch sends unattended unless it is "auto".`);
  process.exit(1);
}
console.log(`test_mode on · mode=${settings.workflow_mode} · cold offers ${settings.cold_offer_enabled ? "on" : "OFF"} · payments ${settings.payments_paused ? "paused" : "LIVE"}`);

const PCT = settings.default_payout_percent ?? 55;
const TOTAL = 150;
const PAYOUT = Math.round(TOTAL * (PCT / 100) * 100) / 100;
// >72h clears the 6h cold minimum AND earns the long response window.
const DELIVERY = new Date(Date.now() + 4 * 24 * 3600e3).toISOString();
console.log(`both orders: €${TOTAL} → €${PAYOUT} payout (ceiling €${settings.cold_offer_max_payout_eur}), delivering in 96h\n`);

// ── pick one shop of each kind ─────────────────────────────────────────────
// Both shops must own their email address outright.
//
// The offer link signs the florist in BY EMAIL (app/florist/m/[token] calls
// generateLink on florists.email), and `florist_users` binds one auth user to
// one florist. Where two shops share an inbox — 695 of 2,274 emailable shops on
// this project, one address covering 115 of them — the second shop cannot be
// signed in as itself: the session resolves to whichever florist was bound
// first and /api/florist/respond answers "Not your offer." Verified, not
// assumed: an accept on a shared-address shop returned exactly that 403.
//
// A fixture that ignored this would look like a routing failure and be nothing
// of the kind, so the pick is filtered rather than left to luck.
// Second identity trap, same root cause: `florist_users` keys a shop to ONE auth
// user, and ensureFloristUser always inserts role "owner" against a unique index
// (florist_users_one_owner_idx). If a shop's florists.email no longer matches the
// address its owner actually signed up with, the magic link signs in as a
// DIFFERENT auth user, the insert is refused by that index, and every florist API
// answers 401 "Not signed in as a florist" — the florist reaches the app and can
// do nothing. Verified on two shops here.
const { data: authPage } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
const authEmailById = new Map(authPage.users.map((u) => [u.id, (u.email ?? "").toLowerCase()]));
async function canSignInAsItself(f) {
  const { data: link } = await db.from("florist_users").select("user_id").eq("florist_id", f.id).maybeSingle();
  if (!link) return true; // nobody linked yet — the magic link will bind cleanly
  return authEmailById.get(link.user_id) === (f.email ?? "").toLowerCase();
}

async function ownsItsAddress(email) {
  const { count } = await db
    .from("florists")
    .select("id", { count: "exact", head: true })
    .eq("email", email)
    .is("deleted_at", null)
    .is("excluded_at", null);
  return count === 1;
}

const { data: networkPool } = await db
  .from("florists")
  .select("id, name, city_id, lat, lng, email, lifecycle_stage, joined_at, delivery_radius_km")
  .in("lifecycle_stage", ["production", "onboarding"])
  .not("joined_at", "is", null)
  .not("email", "is", null)
  .not("lat", "is", null)
  .is("excluded_at", null)
  .is("deleted_at", null)
  .limit(40);
let network = null;
for (const f of networkPool ?? []) {
  if (!(await ownsItsAddress(f.email))) continue;
  if (!(await canSignInAsItself(f))) continue;
  network = f; break;
}

const { data: pool } = await db
  .from("florists")
  .select("id, name, city_id, lat, lng, email, lifecycle_stage, joined_at, excluded_at, deleted_at, order_emails_opt_out")
  .is("joined_at", null)
  .not("email", "is", null)
  .not("lat", "is", null)
  .is("excluded_at", null)
  .is("deleted_at", null)
  .limit(400);
// Judge them with the ENGINE'S own rule rather than trusting the query above.
let cold = null;
for (const f of pool ?? []) {
  if (coldOfferBlockReason(f, { payoutEur: PAYOUT, deliveryAt: DELIVERY }, settings, Date.now()) !== null) continue;
  if (!(await ownsItsAddress(f.email))) continue; // shared-inbox trap
  if (!(await canSignInAsItself(f))) continue; // changed-address trap
  cold = f;
  break;
}
if (!cold) {
  console.error("No never-joined shop passes coldOfferBlockReason — the cold branch cannot send.");
  process.exit(1);
}

console.log(`network branch → ${network.name}  (${network.lifecycle_stage}, joined)`);
console.log(`cold branch    → ${cold.name}  (${cold.lifecycle_stage}, never joined)\n`);

// ── the orders ─────────────────────────────────────────────────────────────
const ITEMS = [
  { title: "Rosas Eternas", variant: "Medium · 24 stems", quantity: 1, unit_price: 110, line_total: 110, product_type: "bouquet", bouquet_spec: "24 red roses, seasonal greenery, kraft wrap", image_url: "https://cdn.shopify.com/s/files/1/0000/0000/products/roses.jpg" },
  { title: "Glass vase", variant: "Clear, 25cm", quantity: 1, unit_price: 40, line_total: 40, product_type: "vase" },
];

async function seed(name, shop, note) {
  await db.from("orders").delete().eq("order_name", name);
  const { data: o, error } = await db
    .from("orders")
    .insert({
      shopify_order_id: `FINDQA-BRANCH-${name.replace(/\D/g, "")}-${Date.now()}`,
      order_name: name,
      shopify_created_at: new Date().toISOString(),
      currency: "EUR",
      total: TOTAL,
      financial_status: "paid",
      buyer_name: "QA Buyer",
      buyer_email: "qa@example.invalid",
      recipient_name: "Ana Ruiz",
      recipient_phone: "+34 600 000 000",
      // The shop's own coordinates, so distance is ~0 and neither the 20km cap
      // nor the shop's delivery_radius_km can be the reason it fails.
      delivery_lat: shop.lat,
      delivery_lng: shop.lng,
      delivery_area: "QA branch test",
      delivery_address: { address1: "Carrer de Prova 1", city: "QA", country: "ES", zip: "00000", name: "Ana Ruiz" },
      delivery_at: DELIVERY,
      delivery_window: "10:00–14:00",
      substitution_policy: "similar_value",
      status: "matched",
      worklist_at: new Date().toISOString(),
      notes: `🧪 ${note} Safe to delete.`,
      ...(shop.city_id ? { city_id: shop.city_id } : {}),
    })
    .select("id")
    .single();
  if (error) throw new Error(`${name}: ${error.message}`);

  const { error: liErr } = await db.from("order_line_items").insert(ITEMS.map((i) => ({ ...i, order_id: o.id })));
  if (liErr) throw new Error(`${name} line items: ${liErr.message}`);

  const { error: aErr } = await db.from("order_assignments").insert({
    order_id: o.id,
    florist_id: shop.id,
    rank: 1,
    status: "candidate",
    offer_kind: "race",
    payout_price: PAYOUT,
    payout_percent: PCT,
    sla_deadline_at: new Date(Date.parse(DELIVERY) - 2 * 3600e3).toISOString(),
  });
  if (aErr) throw new Error(`${name} assignment: ${aErr.message}`);
  return o.id;
}

const netId = await seed("#FIND-10", network, "Network branch — shop has joined, so no cold gate applies.");
const coldId = await seed("#FIND-11", cold, "Cold branch — never joined, passes every cold-offer gate.");

console.log(`✓ #FIND-10  ${netId}   → ${network.name}`);
console.log(`✓ #FIND-11  ${coldId}   → ${cold.name}`);
console.log(`
Both are matched with one candidate each and nothing left to decide.
The wave engine runs every minute; on the next tick BOTH should send with no
approval filed — #FIND-10 because the shop is in the network, #FIND-11 because
it clears every cold-offer gate. Anything else is a real finding.

  node scripts/check-placement-test.mjs        (needs the alias loader)
`);
