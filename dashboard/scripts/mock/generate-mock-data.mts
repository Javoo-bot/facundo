// Mock-data generator — rebuilds a rich, realistic dataset:
//   • real Facundo products with Classic/Premium/Deluxe variants
//   • orders across lifecycle states with per-variant line items
//   • payouts covering EVERY state (paid, issued, failed, declined, held,
//     exposure_capped, insufficient_funds, clawed_back, dispute)
//   • REAL Airwallex sandbox cards + REAL sandbox transactions
//     (authorization + capture) via the simulation API.
//
// Idempotent: deletes prior generated rows (marked notes='mockgen-v2') first.
// Run: npx tsx dashboard/scripts/mock/generate-mock-data.mts
//
// Loads dashboard/.env.local for Supabase service-role + Airwallex sandbox creds.

import fs from "node:fs";

// dashboard/.env.local, relative to this script (dashboard/scripts/mock/).
const ENV = new URL("../../.env.local", import.meta.url);
for (const line of fs.readFileSync(ENV, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const { createServiceClient } = await import("../../lib/supabaseAdmin.ts");
const { issueSingleUseCard } = await import("../../lib/airwallex/cards.ts");
const { airwallexToken } = await import("../../lib/airwallex/client.ts");
const admin = createServiceClient();

const AWX = process.env.AIRWALLEX_BASE || "https://api-demo.airwallex.com";
const MARK = "mockgen-v2";
// Airwallex dedupes card creation by request_id, so a re-run must use fresh ids
// and each card within a run needs a distinct one (equal-split legs collide).
const RUN = Date.now();
let cardSeq = 0;
const pad43 = (s: string) => (s + " ".repeat(43)).slice(0, 43);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- real Facundo catalog (title, subtitle, spec, image, 3 variant prices) ----
type Variant = "Classic" | "Premium" | "Deluxe";
const CDN = "https://cdn.shopify.com/s/files/1/0895/6408/6600/files";
// Each product has a base recipe (flower -> base stem count). MOCK ONLY: the
// per-variant quantity is derived by scaling the base by VARIANT_MULT (real
// data arrives with a distinct recipe per variant, so this scaling lives only
// in the generator).
const CATALOG = {
  subtle:  { title: "Subtle Freshness", sub: "Roses and Lilies", img: `${CDN}/67164d8a62441043743586.jpg`, sku: "FC-SUBTLE", v: { Classic: 59.9, Premium: 68.9, Deluxe: 77.9 }, recipe: [["Pink roses", 6], ["White lilies", 3], ["Pink lisianthus", 3], ["Eucalyptus", 4]] },
  seminyak:{ title: "Seminyak", sub: "Sunflowers & Orange Chrysanthemums", img: `${CDN}/Seminyak_-_no_chocolate.png`, sku: "FC-SEMINYAK", v: { Classic: 39.9, Premium: 44.9, Deluxe: 49.9 }, recipe: [["Sunflowers", 3], ["Orange chrysanthemums", 5], ["Salal greenery", 4]] },
  sunset:  { title: "Vibrant Sunset", sub: "Sunflowers & Purple Statice", img: `${CDN}/Vibrant_Sunset_-_no_chocolate.png`, sku: "FC-SUNSET", v: { Classic: 34.9, Premium: 39.9, Deluxe: 44.9 }, recipe: [["Sunflowers", 3], ["Purple statice", 6], ["Mixed greenery", 4]] },
  golden:  { title: "Golden Melody", sub: "Sunflowers & Aspidistra", img: `${CDN}/Golden_Melody_-_no_chocolate.png`, sku: "FC-GOLDEN", v: { Classic: 34.9, Premium: 39.9, Deluxe: 44.9 }, recipe: [["Sunflowers", 4], ["Aspidistra leaves", 3], ["Solidago", 5]] },
  passion: { title: "Endless Passion", sub: "Red Roses", img: `${CDN}/FC20005_Large_50434792358216_nochoc.png`, sku: "FC-PASSION", v: { Classic: 111.86, Premium: 125.86, Deluxe: 139.86 }, recipe: [["Red roses", 24], ["Eucalyptus", 6], ["Ruscus", 4]] },
  pure:    { title: "Pure White", sub: "White Roses and Lilies", img: `${CDN}/639359623e2d7975093624.jpg`, sku: "FC-PURE", v: { Classic: 94.9, Premium: 101.9, Deluxe: 109.9 }, recipe: [["White roses", 8], ["White lilies", 4], ["Baby's breath", 3], ["Eucalyptus", 5]] },
  classic: { title: "Classic Love", sub: "Red Roses", img: `${CDN}/FC108_Large_50434772107592_nochoc.png`, sku: "FC-CLOVE", v: { Classic: 109.9, Premium: 116.9, Deluxe: 124.9 }, recipe: [["Red roses", 12], ["Eucalyptus", 4], ["Baby's breath", 2]] },
} as const;
type ProductKey = keyof typeof CATALOG;

// More expensive variant => fuller bouquet (more stems). Mock-only.
const VARIANT_MULT: Record<Variant, number> = { Classic: 1, Premium: 1.4, Deluxe: 1.8 };

// Build a "Flower x N, Flower x N" spec (IngredientList renders one per line).
function recipeSpec(key: ProductKey, variant: Variant): string {
  const mult = VARIANT_MULT[variant];
  return CATALOG[key].recipe.map(([flower, base]) => `${flower} x ${Math.max(1, Math.round((base as number) * mult))}`).join(", ");
}

// non-bouquet add-ons (product_type != bouquet)
const ADDONS = {
  choc:  { title: "Belgian Chocolates", type: "chocolate", price: 14.9, img: `${CDN}/choc.png` },
  wine:  { title: "Rioja Reserva Red Wine", type: "wine", price: 19.9, img: `${CDN}/wine.png` },
  teddy: { title: "Plush Teddy Bear", type: "teddy", price: 12.9, img: `${CDN}/teddy.png` },
} as const;

// ---- scenarios: order lifecycle + payout outcome we want to demonstrate ----
type Scenario =
  | "paid" | "paid_both" | "issued_auth" | "failed" | "declined"
  | "held" | "exposure_capped" | "insufficient_funds" | "clawed_back" | "dispute" | "pending_ledger" | "offer";

interface OrderSpec {
  n: number;
  name: string;
  occasion: string;
  greeting: string;
  floristPlaceId: string;
  orderStatus: string;
  assignStatus: string;
  items: Array<[ProductKey, Variant, number]>;
  addons?: Array<keyof typeof ADDONS>;
  scenario: Scenario;
}

const ORDERS: OrderSpec[] = [
  { n: 1, name: "#3001", occasion: "birthday", greeting: "Feliç aniversari! 🎉", floristPlaceId: "MOCK-GI-01", orderStatus: "delivered", assignStatus: "delivered", items: [["subtle", "Premium", 1]], scenario: "paid" },
  { n: 2, name: "#3002", occasion: "anniversary", greeting: "Amb tot el meu amor ❤️", floristPlaceId: "MOCK-GI-03", orderStatus: "delivered", assignStatus: "delivered", items: [["passion", "Deluxe", 1]], addons: ["choc"], scenario: "paid_both" },
  { n: 3, name: "#3003", occasion: "sympathy", greeting: "With deepest sympathy", floristPlaceId: "MOCK-GI-06", orderStatus: "accepted", assignStatus: "accepted", items: [["pure", "Classic", 1]], scenario: "issued_auth" },
  { n: 4, name: "#3004", occasion: "congratulations", greeting: "Congratulations! 🥂", floristPlaceId: "MOCK-GI-02", orderStatus: "accepted", assignStatus: "accepted", items: [["classic", "Premium", 1]], addons: ["wine"], scenario: "dispute" },
  { n: 5, name: "#3005", occasion: "get_well", greeting: "Get well soon 🌻", floristPlaceId: "MOCK-GI-04", orderStatus: "delivered", assignStatus: "delivered", items: [["golden", "Classic", 1]], scenario: "clawed_back" },
  { n: 6, name: "#3006", occasion: "love", greeting: "Thinking of you", floristPlaceId: "MOCK-GI-01", orderStatus: "accepted", assignStatus: "accepted", items: [["seminyak", "Deluxe", 1]], scenario: "declined" },
  { n: 7, name: "#3007", occasion: "birthday", greeting: "Happy birthday!", floristPlaceId: "MOCK-GI-05", orderStatus: "accepted", assignStatus: "accepted", items: [["sunset", "Premium", 2]], scenario: "failed" },
  { n: 8, name: "#3008", occasion: "new_baby", greeting: "Welcome, little one 👶", floristPlaceId: "MOCK-GI-08", orderStatus: "accepted", assignStatus: "accepted", items: [["subtle", "Deluxe", 1]], addons: ["teddy"], scenario: "held" },
  { n: 9, name: "#3009", occasion: "thank_you", greeting: "Thank you so much", floristPlaceId: "MOCK-GI-07", orderStatus: "accepted", assignStatus: "accepted", items: [["passion", "Premium", 1]], scenario: "exposure_capped" },
  { n: 10, name: "#3010", occasion: "anniversary", greeting: "Happy anniversary", floristPlaceId: "MOCK-GI-02", orderStatus: "accepted", assignStatus: "accepted", items: [["pure", "Deluxe", 1]], scenario: "insufficient_funds" },
  { n: 11, name: "#3011", occasion: "birthday", greeting: "Bon aniversari!", floristPlaceId: "MOCK-GI-03", orderStatus: "reaching_out", assignStatus: "sent", items: [["golden", "Premium", 1]], scenario: "pending_ledger" },
  { n: 12, name: "#3012", occasion: "love", greeting: "Je t'aime 💕", floristPlaceId: "MOCK-GI-01", orderStatus: "delivered", assignStatus: "delivered", items: [["classic", "Deluxe", 1], ["seminyak", "Classic", 1]], scenario: "paid_both" },
  // Open offers awaiting the florist's response — so the demo florist (MOCK-GI-01)
  // always has fresh, actionable "New orders" to accept, not just history.
  { n: 13, name: "#3013", occasion: "birthday", greeting: "Happy birthday! 🎂", floristPlaceId: "MOCK-GI-01", orderStatus: "reaching_out", assignStatus: "sent", items: [["sunset", "Premium", 1]], scenario: "offer" },
  { n: 14, name: "#3014", occasion: "anniversary", greeting: "To many more years ❤️", floristPlaceId: "MOCK-GI-01", orderStatus: "reaching_out", assignStatus: "sent", items: [["passion", "Deluxe", 1]], addons: ["choc"], scenario: "offer" },
  { n: 15, name: "#3015", occasion: "get_well", greeting: "Get well soon 🌻", floristPlaceId: "MOCK-GI-01", orderStatus: "reaching_out", assignStatus: "sent", items: [["golden", "Classic", 1]], scenario: "offer" },
];

const uuid = (n: number) => `00000000-0000-4dda-a000-${String(n).padStart(12, "0")}`;
const nowMinus = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
const nowPlus = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

// ---- Airwallex sandbox simulation helpers ----
async function simAuthorize(token: string, cardId: string, amount: number, failReason?: string) {
  const body: Record<string, unknown> = {
    card_id: cardId, transaction_amount: amount, transaction_currency: "EUR",
    merchant_category_code: "5992", merchant_info: pad43("FACUNDO FLORIST BARCELONA ES"),
  };
  if (failReason) body.transaction_failure_reason = failReason;
  const res = await fetch(`${AWX}/api/v1/simulation/issuing/create`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) return { ok: false as const, error: `${res.status} ${txt.slice(0, 120)}` };
  const j = JSON.parse(txt);
  return { ok: true as const, txnId: j.transaction_id ?? j.id ?? null, raw: j };
}
async function simCapture(token: string, txnId: string, amount: number) {
  const res = await fetch(`${AWX}/api/v1/simulation/issuing/${txnId}/capture`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ transaction_amount: amount, merchant_info: pad43("FACUNDO FLORIST BARCELONA ES") }),
  });
  return res.ok;
}

async function main() {
  // ---------- 0. resolve florists + city ----------
  const { data: fls } = await admin.from("florists").select("id, place_id, trust_tier");
  const byPlace = new Map((fls ?? []).map((f: any) => [f.place_id, f]));
  const { data: cityRow } = await admin.from("cities").select("id").eq("country", "ES").eq("city", "Girona").single();
  const cityId = cityRow?.id ?? null;

  // Ensure a tier-4 (hold) florist exists for the 'held' scenario.
  const holdFlorist = byPlace.get("MOCK-GI-08");
  if (holdFlorist && holdFlorist.trust_tier !== "4") {
    await admin.from("florists").update({ trust_tier: "4" }).eq("id", holdFlorist.id);
    console.log(`set ${holdFlorist.place_id} -> tier 4 (hold) for the held scenario`);
  }

  // ---------- 1. clean prior generated rows ----------
  const { data: prev } = await admin.from("orders").select("id").eq("notes", MARK);
  const prevIds = (prev ?? []).map((r: any) => r.id);
  if (prevIds.length) {
    // payouts/payment_events/line_items/assignments/events cascade via FK on delete, but
    // payment_events references payouts (set null) — delete children explicitly first.
    const { data: pas } = await admin.from("order_assignments").select("id").in("order_id", prevIds);
    const paIds = (pas ?? []).map((r: any) => r.id);
    const paSet = new Set(paIds);
    if (paIds.length) {
      const { data: pos } = await admin.from("payouts").select("id").in("assignment_id", paIds);
      const poIds = (pos ?? []).map((r: any) => r.id);
      if (poIds.length) await admin.from("payment_events").delete().in("payout_id", poIds);
      // Also drop the payout_id=null events (held / exposure_capped / insufficient_funds /
      // pending) keyed by payload.assignmentId — otherwise they stack across re-runs.
      const { data: nullEv } = await admin.from("payment_events").select("id, payload").is("payout_id", null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payment_events payload is untyped
      const orphanIds = (nullEv ?? []).filter((e: any) => e.payload?.assignmentId && paSet.has(e.payload.assignmentId)).map((e: any) => e.id);
      if (orphanIds.length) await admin.from("payment_events").delete().in("id", orphanIds);
      await admin.from("payouts").delete().in("assignment_id", paIds);
    }
    await admin.from("orders").delete().in("id", prevIds); // cascades assignments, line_items, order_events
    console.log(`cleaned ${prevIds.length} prior generated orders`);
  }

  const token = await airwallexToken();
  const summary: string[] = [];

  // ---------- 2. build each order ----------
  for (const o of ORDERS) {
    const fl = byPlace.get(o.floristPlaceId);
    if (!fl) { console.log(`skip ${o.name}: florist ${o.floristPlaceId} missing`); continue; }
    const orderId = uuid(o.n);
    const assignId = uuid(1000 + o.n);

    const lineItems = o.items.map(([key, variant, qty]) => {
      const p = CATALOG[key];
      const unit = p.v[variant];
      return { title: `${p.title} — ${p.sub}`, variant, sku: `${p.sku}-${variant.toUpperCase()}`, quantity: qty, unit_price: unit, line_total: round2(unit * qty), product_type: "bouquet", bouquet_spec: recipeSpec(key, variant), image_url: p.img };
    });
    for (const a of o.addons ?? []) {
      const ad = ADDONS[a];
      lineItems.push({ title: ad.title, variant: null as any, sku: `FC-${a.toUpperCase()}`, quantity: 1, unit_price: ad.price, line_total: ad.price, product_type: ad.type, bouquet_spec: null as any, image_url: ad.img });
    }
    const total = round2(lineItems.reduce((s, li) => s + li.line_total, 0));

    await admin.from("orders").insert({
      id: orderId, shopify_order_id: `MOCK-${5300000 + o.n}`, order_name: o.name, shopify_created_at: nowMinus(6),
      currency: "EUR", total, financial_status: "paid", city_id: cityId,
      buyer_name: "Test Buyer", buyer_email: "buyer@example.com", recipient_name: "Recipient Name", recipient_phone: "+34 600 000 000",
      delivery_address: { address1: "Carrer de Test 10", city: "Girona", zip: "17001", country_code: "ES" },
      delivery_area: "Girona · Barri Vell", delivery_lat: 41.9861, delivery_lng: 2.825,
      delivery_at: nowPlus(20), delivery_window: "10:00–14:00", occasion: o.occasion, greeting: o.greeting,
      status: o.orderStatus, notes: MARK,
    });
    await admin.from("order_line_items").insert(lineItems.map((li) => ({ order_id: orderId, ...li })));
    await admin.from("order_assignments").insert({
      id: assignId, order_id: orderId, florist_id: fl.id, rank: 1, florist_source: "existing",
      status: o.assignStatus, payout_price: total, accepted_at: o.assignStatus === "accepted" || o.assignStatus === "delivered" ? nowMinus(4) : null,
    });

    const r = await generatePayouts(token, o, assignId, orderId, fl, total);
    summary.push(`${o.name.padEnd(6)} ${o.scenario.padEnd(18)} ${r}`);
    console.log(`${o.name} ${o.scenario} — ${r}`);
  }

  console.log("\n=== SUMMARY ===");
  summary.forEach((s) => console.log("  " + s));
}

// Insert the payout(s) + real transactions for a scenario. Returns a short note.
async function generatePayouts(token: string, o: OrderSpec, assignId: string, orderId: string, fl: any, total: number): Promise<string> {
  const tier = fl.trust_tier as string;
  // Mirrors the trust_tiers table splits (tier-2 is 70/30). The live payout
  // flow reads trust_tiers; this hardcoded map only seeds mock payouts.
  const acceptPct = tier === "1" ? 100 : tier === "2" ? 70 : 0;
  const acceptAmt = round2((total * acceptPct) / 100);
  const deliveryAmt = round2(total - acceptAmt);

  const insertPayout = async (leg: string, amount: number, status: string, rail: string, providerRef: string | null, extra: Record<string, unknown> = {}) => {
    const { data } = await admin.from("payouts").insert({ assignment_id: assignId, leg, amount, currency: "EUR", rail, status, provider_ref: providerRef, ...extra }).select("id").single();
    return data?.id as string;
  };
  const event = (payoutId: string | null, type: string, payload: Record<string, unknown>) => admin.from("payment_events").insert({ payout_id: payoutId, type, payload });
  const issueCard = async (amount: number) => issueSingleUseCard(Math.round(amount * 100), "EUR", `${assignId}:${RUN}:${cardSeq++}`);

  switch (o.scenario) {
    case "paid": {
      const c = await issueCard(acceptAmt);
      if (!c.ok) return `card issue failed: ${c.error}`;
      const auth = await simAuthorize(token, c.providerRef, acceptAmt);
      const captured = auth.ok && auth.txnId ? await simCapture(token, auth.txnId, acceptAmt) : false;
      // Honest: only 'paid' when a REAL transaction was captured; otherwise the
      // card is real but there's no settlement yet -> 'issued'.
      const pid = await insertPayout("accept", acceptAmt, captured ? "paid" : "issued", "card", c.providerRef, {
        spent_amount: auth.ok ? acceptAmt : null, last_txn_id: auth.ok ? auth.txnId : null, settled_at: captured ? new Date().toISOString() : null, card_status: "ACTIVE",
      });
      await event(pid, "issued", { last4: c.last4 });
      if (auth.ok) await event(pid, "authorized", { txnId: auth.txnId, amount: acceptAmt });
      if (captured) await event(pid, "settled", { txnId: auth.txnId, amount: acceptAmt });
      return `card ${c.last4} · ${captured ? "real txn→paid" : auth.ok ? "authorized" : `no txn (${auth.error})`}`;
    }
    case "paid_both": {
      const notes: string[] = [];
      for (const [leg, amt] of [["accept", acceptAmt], ["delivery", deliveryAmt]] as const) {
        if (amt <= 0) continue;
        await new Promise((r) => setTimeout(r, 400)); // space out card issuance (avoid rate limits)
        const c = await issueCard(amt);
        if (!c.ok) { notes.push(`${leg}:issue-fail ${c.error?.slice(0, 40)}`); continue; }
        const auth = await simAuthorize(token, c.providerRef, amt);
        const captured = auth.ok && auth.txnId ? await simCapture(token, auth.txnId, amt) : false;
        const pid = await insertPayout(leg, amt, captured ? "paid" : "issued", "card", c.providerRef, { spent_amount: auth.ok ? amt : null, last_txn_id: auth.ok ? auth.txnId : null, settled_at: captured ? new Date().toISOString() : null, card_status: "ACTIVE" });
        await event(pid, "issued", { last4: c.last4 });
        if (captured) await event(pid, "settled", { txnId: auth.txnId, amount: amt });
        notes.push(`${leg} ${c.last4}${captured ? "→paid" : ""}`);
      }
      return notes.join(" · ");
    }
    case "issued_auth": {
      const leg = acceptPct > 0 ? "accept" : "delivery";
      const amt = acceptPct > 0 ? acceptAmt : deliveryAmt;
      const c = await issueCard(amt);
      if (!c.ok) return `card issue failed: ${c.error}`;
      const auth = await simAuthorize(token, c.providerRef, amt); // authorized, NOT captured (pending settlement)
      const pid = await insertPayout(leg, amt, "issued", "card", c.providerRef, { spent_amount: auth.ok ? amt : null, last_txn_id: auth.ok ? auth.txnId : null, card_status: "ACTIVE" });
      await event(pid, "issued", { last4: c.last4 });
      if (auth.ok) await event(pid, "authorized", { txnId: auth.txnId, amount: amt });
      return `card ${c.last4} · authorized (awaiting capture)`;
    }
    case "dispute": {
      const c = await issueCard(acceptAmt);
      if (!c.ok) return `card issue failed: ${c.error}`;
      const auth = await simAuthorize(token, c.providerRef, acceptAmt);
      const captured = auth.ok && auth.txnId ? await simCapture(token, auth.txnId, acceptAmt) : false;
      const pid = await insertPayout("accept", acceptAmt, captured ? "paid" : "issued", "card", c.providerRef, { spent_amount: auth.ok ? acceptAmt : null, last_txn_id: auth.ok ? auth.txnId : null, settled_at: captured ? new Date().toISOString() : null, dispute_status: "IN_PROGRESS", card_status: "ACTIVE" });
      await event(pid, "issued", { last4: c.last4 });
      await event(pid, "dispute", { disputeStatus: "IN_PROGRESS", txnId: auth.ok ? auth.txnId : null });
      return `card ${c.last4} · dispute IN_PROGRESS`;
    }
    case "declined": {
      const c = await issueCard(acceptAmt);
      if (!c.ok) return `card issue failed: ${c.error}`;
      const fail = await simAuthorize(token, c.providerRef, acceptAmt, "TRANSACTION_BLOCKED");
      const pid = await insertPayout("accept", acceptAmt, "issued", "card", c.providerRef, { last_txn_id: fail.ok ? fail.txnId : null, card_status: "ACTIVE" });
      await event(pid, "issued", { last4: c.last4 });
      await event(pid, "declined", { reason: "TRANSACTION_BLOCKED" });
      return `card ${c.last4} · declined auth (${fail.ok ? "sim ok" : fail.error})`;
    }
    case "failed": {
      const pid = await insertPayout("accept", acceptAmt, "failed", "card", null);
      await event(pid, "failed", { error: "Airwallex 402: card program limit exceeded" });
      return `payout failed (rail rejected)`;
    }
    case "held": {
      // tier-4: delivery leg is held (hold_payout) — no payout row, a 'held' event.
      await event(null, "held", { assignmentId: assignId, leg: "delivery", tier });
      return `held (tier 4, no card issued)`;
    }
    case "exposure_capped": {
      await event(null, "exposure_capped", { assignmentId: assignId, leg: "delivery", amount: deliveryAmt, cap: 200 });
      return `exposure_capped (delivery ${deliveryAmt} > cap 200)`;
    }
    case "insufficient_funds": {
      await event(null, "insufficient_funds", { assignmentId: assignId, leg: acceptPct > 0 ? "accept" : "delivery", amount: acceptPct > 0 ? acceptAmt : deliveryAmt, currency: "EUR", available: 5.0 });
      return `insufficient_funds (wallet too low)`;
    }
    case "clawed_back": {
      const leg = acceptPct > 0 ? "accept" : "delivery";
      const amt = acceptPct > 0 ? acceptAmt : deliveryAmt;
      const c = await issueCard(amt);
      const providerRef = c.ok ? c.providerRef : null;
      const pid = await insertPayout(leg, amt, "issued", "card", providerRef, { card_status: "CLOSED" });
      await event(pid, "issued", { last4: c.ok ? c.last4 : null });
      // full cancel → negative clawback row on the same assignment
      const cb = await insertPayout("accept", -amt, "clawed_back", "card", null);
      await event(cb, "clawed_back", { orderId, assignmentId: assignId, recovered: amt, newTotal: null });
      await event(pid, "card_closed", { orderId, cardId: providerRef, source: "clawback" });
      return `issued ${amt} then clawed_back -${amt} (card closed)`;
    }
    case "pending_ledger": {
      // ledger rail (offer still out) — intent recorded, no card.
      const pid = await insertPayout("accept", acceptAmt, "pending", "sepa", null);
      await event(pid, "issued", { note: "ledger intent (offer pending)" });
      return `pending (ledger rail)`;
    }
    case "offer": {
      // Open offer awaiting the florist's response — no payout exists yet;
      // the payout is only created on accept. Keeps the balance clean.
      return `open offer (no payout yet)`;
    }
    default:
      return "no payout";
  }
}

await main();
process.exit(0);
