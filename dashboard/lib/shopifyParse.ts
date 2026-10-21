// Faithful dashboard-side port of the ingest-worker's `parseShopifyOrder`
// (ingest-worker/src/shopify.ts). Kept byte-for-byte equivalent in behaviour so
// that an order pulled via the staff "Pull from Shopify" button maps EXACTLY the
// way a live webhook order would — the point of that tool is to see the real
// parser's output on real payloads before the live webhook is armed. When the
// worker's parser is improved (occasion/greeting across all line items, catalog
// photo/recipe backfill, malformed-order flagging — see the go-live audit), fix
// both in lockstep. Pure + `import type`-free so it stays trivially testable.

import { regionToLocale } from "./i18n/locales.ts";

export interface OrderInsert {
  shopify_order_id: string; order_name: string | null; shopify_created_at: string | null;
  currency: string | null; total: number | null; shipping_total: number | null; financial_status: string | null;
  fulfillment_status: string | null; locale: string | null;
  buyer_name: string | null; buyer_email: string | null; buyer_phone: string | null;
  recipient_name: string | null; recipient_phone: string | null;
  delivery_address: Record<string, unknown> | null; delivery_area: string | null;
  delivery_lat: number | null; delivery_lng: number | null;
  delivery_at: string | null; delivery_window: string | null;
  occasion: string | null; greeting: string | null; tags: string | null; status: string; raw: unknown;
}
export interface LineItemInsert {
  title: string | null; variant: string | null; sku: string | null; catalog_id: string | null;
  /** The Shopify VARIANT id. `catalog_id` is the product id; both are needed —
   *  the recipe is a per-variant metafield, so translating it (lib/translations)
   *  can only find the right metafield from the variant. */
  variant_id: string | null;
  quantity: number; unit_price: number | null; line_total: number | null;
  product_type: string | null; bouquet_spec: string | null; image_url: string | null; personalization: string | null;
  // Backfilled via a follow-up GraphQL variant lookup (see shopifyVariantDetails.ts)
  // — never present in the REST order payload this parser works from.
  barcode: string | null; components: string | null; addons: string | null;
  variant_text: string | null; variant_icon_url: string | null;
}

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

function productType(title: string): string {
  const t = title.toLowerCase();
  if (/wine|champagne|cava/.test(t)) return "wine";
  if (/chocolate|choc/.test(t)) return "chocolate";
  if (/vase/.test(t)) return "vase";
  if (/card/.test(t)) return "card";
  return "bouquet";
}

type NameValue = { name?: string; value?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Shopify JSON
function prop(li: any, name: string): string | null {
  const props = (li.properties ?? []) as NameValue[];
  const p = props.find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return p?.value ?? null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Shopify JSON
function attr(raw: any, name: string): string | null {
  const attrs = (raw.note_attributes ?? []) as NameValue[];
  const a = attrs.find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return a?.value ?? null;
}

// Real storefront checkout/date-picker apps don't agree on one attribute name —
// this store's has used "delivery_date_iso" alongside a human-readable
// "Delivery Date" ("24 July 2026") that isn't safely machine-parseable. Only
// look for ISO-shaped (YYYY-MM-DD) values here; legacy "delivery_date" kept for
// stores that used that name directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Shopify JSON
function deliveryDateAttr(raw: any): string | null {
  const iso = attr(raw, "delivery_date_iso") ?? attr(raw, "delivery_date");
  return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Shopify JSON
export function parseShopifyOrder(raw: any): { order: OrderInsert; items: LineItemInsert[] } {
  const ship = raw.shipping_address ?? {};
  const cust = raw.customer ?? {};
  const li0 = (raw.line_items ?? [])[0] ?? {};
  const date = deliveryDateAttr(raw);
  const window = attr(raw, "delivery_window");
  const order: OrderInsert = {
    shopify_order_id: String(raw.id),
    order_name: raw.name ?? null,
    shopify_created_at: raw.created_at ?? null,
    currency: raw.currency ?? null,
    total: num(raw.total_price),
    // Order total already nets in tax/discounts — the florist payout formula
    // deliberately works off items + delivery only, so shipping is captured
    // separately. `shipping_lines[].discounted_price` summed is the fallback for
    // API-version variance; the order-level rollup is preferred when present.
    shipping_total: num(raw.total_shipping_price_set?.shop_money?.amount) ??
      (Array.isArray(raw.shipping_lines) && raw.shipping_lines.length
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Shopify JSON
        ? raw.shipping_lines.reduce((s: number, sl: any) => s + (num(sl.discounted_price ?? sl.price) ?? 0), 0)
        : null),
    financial_status: raw.financial_status ?? null,
    fulfillment_status: raw.fulfillment_status ?? null,
    // Shopify sends `locale` only when the storefront captured one, and for our
    // French traffic it never does — every French order in staging carries null,
    // which resolves to English at read time. The delivery country is the better
    // signal and is already on the row, so fall back to it rather than losing the
    // language. Same map, and the same "unlisted country → null → English" rule,
    // that decides a florist's locale at ingest.
    locale: raw.locale ?? regionToLocale(ship.country_code ?? null) ?? null,
    buyer_name: [cust.first_name, cust.last_name].filter(Boolean).join(" ") || null,
    // Guest checkouts can leave `customer` null while the order-level email
    // survives on `email`/`contact_email` — fall back rather than lose the buyer.
    buyer_email: cust.email ?? raw.email ?? raw.contact_email ?? null,
    buyer_phone: cust.phone ?? raw.phone ?? null,
    recipient_name: ship.name ?? null,
    recipient_phone: ship.phone ?? null,
    delivery_address: raw.shipping_address ? { line1: ship.address1, line2: ship.address2, city: ship.city, postal: ship.zip, region: ship.province, country: ship.country_code } : null,
    delivery_area: [ship.city, ship.province].filter(Boolean).join(" · ") || null,
    delivery_lat: num(ship.latitude),
    delivery_lng: num(ship.longitude),
    delivery_at: date ? `${date}T${(window ?? "").split("-")[0] || "09:00"}:00` : null,
    delivery_window: window,
    occasion: prop(li0, "Occasion") ?? attr(raw, "Occasion"),
    // Prefer an explicit line-item "Greeting" property, but this store's checkout
    // app instead writes the customer's message as an order-level "custom_message"
    // note attribute (also mirrored into a `checkoutblocks.add_a_message`
    // metafield, which isn't in the standard REST order payload) — fall back to it.
    greeting: prop(li0, "Greeting") ?? attr(raw, "custom_message"),
    tags: typeof raw.tags === "string" && raw.tags.length ? raw.tags : null,
    status: "received",
    raw,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw Shopify JSON
  const items: LineItemInsert[] = (raw.line_items ?? []).map((li: any) => ({
    title: li.title ?? null, variant: li.variant_title ?? null, sku: li.sku ?? null,
    catalog_id: li.product_id != null ? String(li.product_id) : null,
    variant_id: li.variant_id != null ? String(li.variant_id) : null,
    quantity: li.quantity ?? 1, unit_price: num(li.price),
    line_total: num(li.price) != null ? Number(li.price) * (li.quantity ?? 1) - (num(li.total_discount) ?? 0) : null,
    product_type: productType(li.title ?? ""), bouquet_spec: null,
    image_url: null, personalization: prop(li, "Greeting"),
    barcode: null, components: null, addons: null, variant_text: null, variant_icon_url: null,
  }));
  return { order, items };
}
