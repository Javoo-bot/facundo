import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { verifyShopifyHmac, parseShopifyOrder } from "../src/shopify";

const raw = readFileSync(fileURLToPath(new URL("./fixtures/shopify-order-1043.json", import.meta.url)), "utf8");

describe("verifyShopifyHmac", () => {
  it("accepts a correctly-signed body and rejects a tampered one", async () => {
    const secret = "shpss_test_secret";
    // Compute the expected header the same way Shopify does (HMAC-SHA256, base64).
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const header = btoa(String.fromCharCode(...new Uint8Array(sig)));
    expect(await verifyShopifyHmac(raw, header, secret)).toBe(true);
    expect(await verifyShopifyHmac(raw + " ", header, secret)).toBe(false);
    expect(await verifyShopifyHmac(raw, "bogus", secret)).toBe(false);
  });
});

describe("parseShopifyOrder", () => {
  it("maps the Shopify Order onto our order + line items", () => {
    const { order, items } = parseShopifyOrder(JSON.parse(raw));
    expect(order.shopify_order_id).toBe("5219483001");
    expect(order.order_name).toBe("#1043");
    expect(order.currency).toBe("EUR");
    expect(order.financial_status).toBe("paid");
    expect(order.recipient_name).toBe("Marta S.");
    expect(order.delivery_lat).toBeCloseTo(41.9861);
    expect(order.occasion).toBe("Birthday");
    expect(order.greeting).toContain("Feliç");
    expect(order.delivery_at).toContain("2026-07-14");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Subtle Freshness");
    expect(items[0].product_type).toBe("bouquet");
  });

  it("prefers delivery_date_iso over the human-readable 'Delivery Date' note attribute", () => {
    // Real order shape: this store writes BOTH a machine-parseable ISO date and a
    // human-readable one ("24 July 2026", not machine-parseable) — must not
    // accidentally pick the human string.
    const { order } = parseShopifyOrder({
      id: 999,
      line_items: [{ title: "Classic Love", price: "41.90", properties: [] }],
      note_attributes: [
        { name: "delivery_date_iso", value: "2026-07-24" },
        { name: "Delivery Date", value: "24 July 2026" },
      ],
    });
    expect(order.delivery_at).toBe("2026-07-24T09:00:00");
  });

  it("greeting falls back to custom_message and preserves literal newlines + emoji", () => {
    const { order } = parseShopifyOrder({
      id: 998,
      line_items: [{ title: "Classic Love", price: "41.90", properties: [] }], // no li0 "Greeting" property
      note_attributes: [{ name: "custom_message", value: "Amor mío,\nTu Luca ❤️" }],
    });
    expect(order.greeting).toBe("Amor mío,\nTu Luca ❤️");
  });
});
