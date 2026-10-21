#!/usr/bin/env node
// The garden's weather: about 20 invented orders a day, each carrying one
// /lifecycle branch, posted to the garden worker's real Shopify webhook so the
// garden's own every-minute cron carries them. Each one writes a
// garden_scenarios row with the outcome the loop should reach.
//
//   node agents/garden/weather.mjs plant [--day YYYY-MM-DD]   plant the day (idempotent)
//   node agents/garden/weather.mjs status [--day YYYY-MM-DD]  where the day's orders are now
//
// Garden DB only (weather-lib.mjs refuses anything else). Rerunning a day
// plants nothing twice: every order id is GARDEN-<yyyymmdd>-<nn>.
import { db, inList, preflight, postWebhook, seededRandom, madridDate, addDays, compact, sleep } from "./weather-lib.mjs";
import { MARK, TOWNS, SHOPS, pickForDay, RECIPIENTS, CARDS } from "./weather-catalogue.mjs";

const KM_LAT = 111.0;
const kmLng = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);
const offset = (t, n, e) => ({ lat: t.lat + n / KM_LAT, lng: t.lng + e / kmLng(t.lat) });
const plus = (email, tag) => email.replace("@", `+${tag}@`);

async function ensureWorld(testEmail) {
  const cityIds = {};
  for (const [key, t] of Object.entries(TOWNS)) {
    const [found] = await db(`cities?region=eq.${MARK}&city=eq.${encodeURIComponent(t.city)}&select=id`);
    cityIds[key] = found?.id ?? (await db("cities", {
      method: "POST", body: { city: t.city, country: "ES", region: MARK, center_lat: t.lat, center_lng: t.lng, radius_km: 15, source: "manual" },
    }))[0].id;
  }
  const shopIds = {};
  const now = new Date().toISOString();
  for (const s of SHOPS) {
    const t = TOWNS[s.town];
    const p = offset(t, s.n, s.e);
    const onboarded = s.stage === "production";
    const row = {
      place_id: `${MARK}_${s.key}`, name: `${s.name} [${MARK}]`, city_id: cityIds[s.town],
      address: `Calle Mayor ${s.key.slice(1)}, ${t.city}, España`, lat: p.lat, lng: p.lng,
      rating: 4.6, review_count: 80, has_website: false,
      email: s.email ? plus(testEmail, `garden-${s.key.toLowerCase()}`) : null,
      phone_mobile: null, phone_web: null, phone_maps: null, whatsapp: null,
      is_test_shop: false, lifecycle_stage: s.stage, trust_tier: s.tier, delivery_radius_km: s.radius,
      capacity_per_day: s.capacity, order_emails_opt_out: s.optOut, locale: "es", source: onboarded ? "existing" : "new",
      enrichment_notes: s.email ? `${MARK}: invented florist for the garden weather` : `${MARK}: no email found (planted on purpose)`,
    };
    const [found] = await db(`florists?place_id=eq.${row.place_id}&select=id`);
    if (found) {
      await db(`florists?id=eq.${found.id}`, { method: "PATCH", body: row, prefer: "return=minimal" });
      shopIds[s.key] = found.id;
    } else {
      shopIds[s.key] = (await db("florists", {
        method: "POST",
        body: {
          ...row, joined_at: onboarded ? now : null, onboarded_at: onboarded ? now : null,
          join_token: crypto.randomUUID(), join_token_expires_at: new Date(Date.now() + 365 * 864e5).toISOString(),
          unsubscribe_token: crypto.randomUUID(),
        },
      }))[0].id;
    }
  }
  return { cityIds, shopIds };
}

async function ensureGardenTagActive(settings) {
  const tags = settings.active_order_tags ?? [];
  if (tags.some((t) => t.toLowerCase() === MARK.toLowerCase())) return tags;
  const next = [...tags, MARK];
  await db("app_settings?id=eq.1", { method: "PATCH", body: { active_order_tags: next }, prefer: "return=minimal" });
  return next;
}

function orderPayload(id, s, day, rand) {
  const o = s.order ?? {};
  const t = TOWNS[s.town];
  const p = offset(t, 0.3 + rand() * 0.4, rand() * 0.4);
  const recipient = RECIPIENTS[Math.floor(rand() * RECIPIENTS.length)];
  const [first, ...last] = recipient.split(" ");
  const deliveryDate = addDays(day, o.daysOut ?? 1);
  const n = Number(id.slice(-2));
  return {
    id,
    name: `#${id}`,
    currency: "EUR",
    total_price: "55.00",
    total_shipping_price_set: { shop_money: { amount: "6.95", currency_code: "EUR" } },
    financial_status: "paid",
    fulfillment_status: null,
    tags: o.tags ?? `${MARK}, garden-${s.key}`,
    email: "garden-buyer@facundo.example",
    customer: { first_name: "Lucía", last_name: "Compradora", email: "garden-buyer@facundo.example", phone: null },
    shipping_address: {
      name: recipient, first_name: first, last_name: last.join(" "),
      address1: o.address1 ?? `Calle de las Flores ${1 + Math.floor(rand() * 60)}`, address2: null,
      city: o.city ?? t.city, zip: t.zip, province: t.province, country_code: "ES", phone: null,
      latitude: o.coords === false ? undefined : p.lat, longitude: o.coords === false ? undefined : p.lng,
    },
    note_attributes: [
      ...(o.noDate ? [] : [{ name: "delivery_date_iso", value: deliveryDate }, { name: "delivery_window", value: o.window ?? "10:00-14:00" }]),
      { name: "custom_message", value: CARDS[Math.floor(rand() * CARDS.length)] },
    ],
    line_items: [{
      title: "Ramo de rosas rosas", variant_title: "Estándar", sku: "GARDEN-RAMO",
      product_id: 970000000 + Number(compact(day).slice(2)) * 100 + n, variant_id: 980000000 + Number(compact(day).slice(2)) * 100 + n,
      quantity: 1, price: "48.05", total_discount: "0.00", properties: [{ name: "Occasion", value: "Cumpleaños" }],
    }],
    shipping_lines: [{ price: "6.95", discounted_price: "6.95" }],
  };
}

/** Which offer window the loop will use for this order: lib/reachout.ts::suggestedTimeoutMinutes. */
function offerWindow(payload, settings) {
  const attrs = Object.fromEntries(payload.note_attributes.map((a) => [a.name, a.value]));
  if (!attrs.delivery_date_iso) return { window: settings.offer_window_nodate_min, deliveryAt: null };
  // The worker stores date + window start with no zone, which Postgres reads as UTC.
  const deliveryAt = `${attrs.delivery_date_iso}T${attrs.delivery_window.split("-")[0]}:00Z`;
  const hours = (Date.parse(deliveryAt) - Date.now()) / 36e5;
  const window = hours <= 6 ? settings.offer_window_rush_min : hours <= 24 ? settings.offer_window_sameday_min
    : hours <= 72 ? settings.offer_window_standard_min : settings.offer_window_far_min;
  return { window, deliveryAt };
}

function dayArg() {
  const i = process.argv.indexOf("--day");
  const day = i > 0 ? process.argv[i + 1] : madridDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) throw new Error("--day must be YYYY-MM-DD");
  return day;
}

async function plant(day) {
  const settings = await preflight();
  const activeTags = await ensureGardenTagActive(settings);
  const world = await ensureWorld(settings.test_email);
  const rand = seededRandom(`garden-weather-${day}`);
  const picks = pickForDay(rand);
  const ids = picks.map((_, i) => `${MARK}-${compact(day)}-${String(i + 1).padStart(2, "0")}`);
  const existing = new Set((await db(`garden_scenarios?shopify_order_id=${inList(ids)}&select=shopify_order_id`)).map((r) => r.shopify_order_id));
  const landed = new Set((await db(`orders?shopify_order_id=${inList(ids)}&select=shopify_order_id`)).map((r) => r.shopify_order_id));

  const planted = [];
  for (const [i, s] of picks.entries()) {
    const id = ids[i];
    // Built before any skip so the seeded stream, and so every payload, is the same on a rerun.
    const payload = orderPayload(id, s, day, rand);
    if (landed.has(id) || (existing.has(id) && s.deliver === "bad-signature")) continue;
    const { window, deliveryAt } = offerWindow(payload, settings);
    const untilDelivery = deliveryAt ? Math.round((Date.parse(deliveryAt) - Date.now()) / 6e4) : null;
    const maxMinutes = s.budget ? s.budget(window) : untilDelivery;
    await db("garden_scenarios", {
      method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
      body: {
        day, shopify_order_id: id, stage_id: s.stage, branch_id: s.branch, title: s.title, expected_outcome: s.outcome,
        expected: {
          max_minutes: maxMinutes, scenario: s.key, town: TOWNS[s.town].city, offer_window_min: window,
          delivery_at: deliveryAt, ...(s.expect ?? {}), ...(s.actor ? { actor: "puppet-placeholder", steps: s.actor } : {}),
        },
      },
    });
    const status = await postWebhook(payload, { badSignature: s.deliver === "bad-signature" });
    if (s.deliver === "replay") await postWebhook(payload);
    planted.push({ id, key: s.key, status });
    console.log(`${id}  ${s.key.padEnd(24)} -> webhook ${status}`);
  }

  // The orders land asynchronously (queue -> OrderWorkflow); link each scenario to its row.
  for (let i = 0; i < 12 && (await linkOrders(day)) > 0; i++) await sleep(10_000);
  return { day, activeTags, shops: Object.keys(world.shopIds).length, posted: planted.length, alreadyThere: picks.length - planted.length };
}

/** Fills garden_scenarios.order_id from orders; returns how many are still unlinked. */
export async function linkOrders(day) {
  const open = await db(`garden_scenarios?day=eq.${day}&order_id=is.null&select=id,shopify_order_id,branch_id`);
  const waiting = open.filter((r) => r.branch_id !== "webhook-hmac");
  if (!waiting.length) return 0;
  const orders = await db(`orders?shopify_order_id=${inList(waiting.map((r) => r.shopify_order_id))}&select=id,shopify_order_id`);
  for (const o of orders) {
    await db(`garden_scenarios?shopify_order_id=eq.${o.shopify_order_id}`, { method: "PATCH", body: { order_id: o.id }, prefer: "return=minimal" });
  }
  return waiting.length - orders.length;
}

async function status(day) {
  await linkOrders(day);
  const rows = await db(`garden_scenarios?day=eq.${day}&select=shopify_order_id,branch_id,expected_outcome,order_id,expected&order=shopify_order_id`);
  const ids = rows.map((r) => r.order_id).filter(Boolean);
  const orders = ids.length ? await db(`orders?id=${inList(ids)}&select=id,status,escalation_reason`) : [];
  const assigns = ids.length ? await db(`order_assignments?order_id=${inList(ids)}&select=order_id,status,sent_at`) : [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  for (const r of rows) {
    const o = byId.get(r.order_id);
    const a = assigns.filter((x) => x.order_id === r.order_id);
    const offers = a.filter((x) => x.sent_at).length;
    const states = a.map((x) => x.status).join(",");
    console.log([r.shopify_order_id, (r.branch_id ?? "happy").padEnd(32), r.expected_outcome.padEnd(10),
      (o?.status ?? "-").padEnd(12), (o?.escalation_reason ?? "").padEnd(14), `offers=${offers}`, states].join("  "));
  }
}

const [cmd] = process.argv.slice(2);
const day = dayArg();
if (cmd === "plant") console.log(JSON.stringify(await plant(day)));
else if (cmd === "status") await status(day);
else { console.error("usage: weather.mjs plant|status [--day YYYY-MM-DD]"); process.exit(1); }
