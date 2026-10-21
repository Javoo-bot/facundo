// Unit tests for the dashboard-side Shopify order parser (the "Pull from
// Shopify" button's mapping). Faithful port of the worker's parseShopifyOrder —
// these fixtures double as a record of what a real payload maps to, so the
// pre-launch gaps (occasion/greeting from li0 only, null photo/recipe) are
// visible and pinned. Run under node's native TS type-stripping:
//   node --test lib/shopifyParse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShopifyOrder } from "./shopifyParse.ts";

// A realistic Shopify orders/create-shaped payload.
const RAW = {
  id: 5678901234567,
  name: "#1042",
  created_at: "2026-07-20T09:15:00Z",
  currency: "EUR",
  total_price: "74.90",
  financial_status: "paid",
  fulfillment_status: null,
  locale: "es",
  note_attributes: [
    { name: "delivery_date", value: "2026-07-22" },
    { name: "delivery_window", value: "10:00-14:00" },
  ],
  customer: { first_name: "Marta", last_name: "Serra", email: "marta@example.com", phone: "+34600111222" },
  shipping_address: {
    name: "Jordi Puig", phone: "+34600333444",
    address1: "Carrer de Girona 12", address2: "2n 1a", city: "Girona",
    zip: "17001", province: "Catalonia", country_code: "ES",
    latitude: 41.9831, longitude: 2.8249,
  },
  line_items: [
    {
      title: "Subtle Freshness — Roses & Lilies", variant_title: "Standard", sku: "FC-101",
      product_id: 999001, quantity: 1, price: "68.90",
      properties: [
        { name: "Occasion", value: "birthday" },
        { name: "Greeting", value: "Happy birthday! 🎉" },
      ],
    },
    { title: "Lindt Chocolate Box", variant_title: null, sku: "FC-CH1", product_id: 999002, quantity: 1, price: "6.00", properties: [] },
  ],
};

test("maps core order fields from a real-shaped payload", () => {
  const { order } = parseShopifyOrder(RAW);
  assert.equal(order.shopify_order_id, "5678901234567");
  assert.equal(order.order_name, "#1042");
  assert.equal(order.currency, "EUR");
  assert.equal(order.total, 74.9);
  assert.equal(order.financial_status, "paid");
  assert.equal(order.buyer_name, "Marta Serra");
  assert.equal(order.buyer_email, "marta@example.com");
  assert.equal(order.recipient_name, "Jordi Puig");
  assert.equal(order.status, "received");
});

test("delivery_address uses the internal {line1,postal,country} shape", () => {
  const { order } = parseShopifyOrder(RAW);
  assert.deepEqual(order.delivery_address, {
    line1: "Carrer de Girona 12", line2: "2n 1a", city: "Girona",
    postal: "17001", region: "Catalonia", country: "ES",
  });
  assert.equal(order.delivery_area, "Girona · Catalonia");
  assert.equal(order.delivery_lat, 41.9831);
  assert.equal(order.delivery_lng, 2.8249);
});

test("delivery_at is composed from note_attributes date + window start", () => {
  const { order } = parseShopifyOrder(RAW);
  assert.equal(order.delivery_at, "2026-07-22T10:00:00");
  assert.equal(order.delivery_window, "10:00-14:00");
});

test("occasion/greeting come from the first line item's properties", () => {
  const { order } = parseShopifyOrder(RAW);
  assert.equal(order.occasion, "birthday");
  assert.equal(order.greeting, "Happy birthday! 🎉");
});

test("line items map title/variant/sku/qty/price; photo+recipe are null (known gap)", () => {
  const { items } = parseShopifyOrder(RAW);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Subtle Freshness — Roses & Lilies");
  assert.equal(items[0].variant, "Standard");
  assert.equal(items[0].catalog_id, "999001");
  assert.equal(items[0].unit_price, 68.9);
  assert.equal(items[0].product_type, "bouquet");
  // Documented pre-launch gaps: real orders arrive with no photo/recipe.
  assert.equal(items[0].image_url, null);
  assert.equal(items[0].bouquet_spec, null);
  assert.equal(items[1].product_type, "chocolate");
});

test("delivery_date_iso wins over the human-readable 'Delivery Date' note attribute", () => {
  // Real order shape: this store writes BOTH a machine-parseable ISO date and a
  // human-readable one ("24 July 2026", not machine-parseable) — must not
  // accidentally pick the human string.
  const raw = {
    id: 999,
    line_items: [{ title: "Classic Love", price: "41.90", properties: [] }],
    note_attributes: [
      { name: "delivery_date_iso", value: "2026-07-24" },
      { name: "Delivery Date", value: "24 July 2026" },
    ],
  };
  const { order } = parseShopifyOrder(raw);
  assert.equal(order.delivery_at, "2026-07-24T09:00:00");
});

test("greeting falls back to custom_message and preserves literal newlines + emoji", () => {
  const raw = {
    id: 998,
    line_items: [{ title: "Classic Love", price: "41.90", properties: [] }], // no li0 "Greeting" property
    note_attributes: [
      { name: "custom_message", value: "Amor mío,\nTu Luca ❤️" },
    ],
  };
  const { order } = parseShopifyOrder(raw);
  assert.equal(order.greeting, "Amor mío,\nTu Luca ❤️");
});

test("degrades to nulls (no throw) when address/customer/attrs are missing", () => {
  const { order, items } = parseShopifyOrder({ id: 42, line_items: [{ title: "Roses", price: "20.00" }] });
  assert.equal(order.shopify_order_id, "42");
  assert.equal(order.delivery_address, null);
  assert.equal(order.delivery_area, null);
  assert.equal(order.delivery_at, null);
  assert.equal(order.occasion, null);
  assert.equal(order.buyer_name, null);
  assert.equal(items[0].title, "Roses");
});
