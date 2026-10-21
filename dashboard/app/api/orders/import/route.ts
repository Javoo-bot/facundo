import { requireAllowedUser, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { parseShopifyOrder } from "@/lib/shopifyParse";
import { fetchVariantDetails } from "@/lib/shopifyImages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff tool: pull ONE real order straight from the Shopify Admin API by id (or
// #name) and import it into the loop, bypassing the webhook. Two uses: (1) bring
// in an order the webhook missed, (2) — right now, pre-launch — see how the real
// parser maps a genuine Facundo payload, so we can fix the delivery-date /
// occasion / greeting / line-item-photo gaps against real data before arming the
// live webhook. The order lands in `received` (same as a fresh webhook order);
// matching is a separate step (the order page's "Find florists").
//
// Reads SHOPIFY_SHOP (falls back to SHOPIFY_STORE) + SHOPIFY_ADMIN_TOKEN from the
// environment (.dev.local locally). The token must be an Admin API access token
// (shpat_…) with read_orders — NOT the OAuth app client id/secret.

const API_VERSION = "2024-07"; // keep in step with lib/shopifyWriteback.ts

function shopDomain(): string | null {
  const raw = process.env.SHOPIFY_SHOP ?? process.env.SHOPIFY_STORE;
  if (!raw) return null;
  // Accept "x.myshopify.com" or a bare handle "x" → normalise to a full host.
  const h = raw.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return h.includes(".") ? h : `${h}.myshopify.com`;
}

// Build the Admin API URL for the requested identifier. Shopify's internal order
// ids run ~13 digits; this store's order *numbers* (e.g. #2000001) are also
// all-digit and can reach 7-8 digits, so a low digit-count threshold misclassifies
// a real order number as an id (404s against /orders/{id}.json). Only treat it as
// the internal id once it's long enough that no plausible order number would
// collide; anything else (incl. a leading #) is looked up by name.
function orderUrl(base: string, id: string): string {
  const trimmed = id.trim();
  if (/^\d{10,}$/.test(trimmed)) return `${base}/orders/${trimmed}.json`;
  const name = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return `${base}/orders.json?status=any&limit=1&name=${encodeURIComponent(name)}`;
}

// Resolve the delivery city to a known city_id (mirrors the worker's
// findCityIdForOrder) so the imported order behaves like a webhook one. Nullable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- admin client is loosely typed
async function findCityId(admin: any, addr: Record<string, unknown> | null): Promise<string | null> {
  const city = addr?.city as string | undefined;
  const country = addr?.country as string | undefined; // country_code, e.g. "ES"
  if (!city) return null;
  let q = admin.from("cities").select("id").ilike("city", city);
  if (country) q = q.eq("country", country);
  const { data } = await q.limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireAllowedUser();
  if (!gate.ok) return gate.res;

  const body = await req.json().catch(() => ({}));
  const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
  if (!orderId) return jsonError("Provide a Shopify order id or #name.", 400);

  const shop = shopDomain();
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) {
    return jsonError(
      "Shopify Admin API not configured. Set SHOPIFY_SHOP (or SHOPIFY_STORE) and SHOPIFY_ADMIN_TOKEN " +
        "(an Admin API access token, shpat_…, with read_orders — not the OAuth client id/secret).",
      501,
    );
  }

  // 1. Fetch the order from Shopify.
  const base = `https://${shop}/admin/api/${API_VERSION}`;
  let res: globalThis.Response;
  try {
    res = await fetch(orderUrl(base, orderId), {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonError(`Could not reach Shopify: ${e instanceof Error ? e.message : "network error"}`, 502);
  }
  if (res.status === 401 || res.status === 403) {
    return jsonError(`Shopify rejected the token (${res.status}). Check SHOPIFY_ADMIN_TOKEN and its read_orders scope.`, 502);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return jsonError(`Shopify returned ${res.status}. ${detail.slice(0, 200)}`, 502);
  }
  const payload = await res.json().catch(() => null);
  // /orders/{id}.json → { order }, /orders.json?name=… → { orders: [...] }.
  const raw = payload?.order ?? payload?.orders?.[0] ?? null;
  if (!raw || raw.id == null) return jsonError(`No Shopify order found for "${orderId}".`, 404);

  // 2. Parse with the shared (faithful) parser and import. The REST order payload
  // never carries a line-item's image, recipe, components/add-ons, or the
  // customer-facing "Includes" blurb (see shopifyParse.ts) — one extra GraphQL
  // round trip backfills all of it from each line item's variant/product data.
  const { order, items } = parseShopifyOrder(raw);
  const variantIds = (raw.line_items ?? []).map((li: { variant_id?: unknown }) => li.variant_id).filter((v: unknown): v is number | string => v != null).map(String);
  const detailsByVariant = await fetchVariantDetails(shop, token, variantIds);
  items.forEach((item, i) => {
    const variantId = raw.line_items?.[i]?.variant_id;
    const d = variantId != null ? detailsByVariant.get(String(variantId)) : undefined;
    if (!d) return;
    item.image_url = d.imageUrl ?? item.image_url;
    item.barcode = d.barcode;
    item.bouquet_spec = d.recipe;
    item.variant_text = d.variantText;
    item.variant_icon_url = d.variantIconUrl;
    item.components = d.components;
    item.addons = d.addons;
  });

  const admin = createServiceClient();
  const cityId = await findCityId(admin, order.delivery_address);

  const { data: upserted, error: oErr } = await admin
    .from("orders")
    .upsert({ ...order, city_id: cityId }, { onConflict: "shopify_order_id" })
    .select("id, order_name")
    .single();
  if (oErr || !upserted) return jsonError(`Failed to import order: ${oErr?.message ?? "unknown"}`, 500);

  // Idempotent replace of line items (re-pulling the same order refreshes them).
  await admin.from("order_line_items").delete().eq("order_id", upserted.id);
  if (items.length) {
    const { error: liErr } = await admin
      .from("order_line_items")
      .insert(items.map((i) => ({ ...i, order_id: upserted.id })));
    if (liErr) return jsonError(`Order imported but line items failed: ${liErr.message}`, 500);
  }

  await admin.from("order_events").insert({
    order_id: upserted.id,
    type: "received",
    payload: { source: "shopify_pull", shopify_order_id: order.shopify_order_id },
    actor: gate.email,
  });

  return Response.json({
    ok: true,
    orderId: upserted.id,
    orderName: upserted.order_name ?? order.order_name,
    items: items.length,
  });
}
