import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyOAuthCallbackHmac } from "../scripts/get-shopify-admin-token.mjs";

const SECRET = "shpss_test_secret";

function sign(params: Record<string, string>) {
  const message = Object.keys(params)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", SECRET).update(message).digest("hex");
}

describe("verifyOAuthCallbackHmac", () => {
  it("accepts a correctly-signed callback", () => {
    const params = { code: "abc123", shop: "your-store.myshopify.com", state: "xyz", timestamp: "1700000000" };
    const hmac = sign(params);
    expect(verifyOAuthCallbackHmac({ ...params, hmac }, SECRET)).toBe(true);
  });

  it("rejects a tampered param (hmac no longer matches)", () => {
    const params = { code: "abc123", shop: "your-store.myshopify.com", state: "xyz", timestamp: "1700000000" };
    const hmac = sign(params);
    expect(verifyOAuthCallbackHmac({ ...params, code: "tampered", hmac }, SECRET)).toBe(false);
  });

  it("rejects a bogus hmac", () => {
    const params = { code: "abc123", shop: "your-store.myshopify.com", state: "xyz" };
    expect(verifyOAuthCallbackHmac({ ...params, hmac: "bogus" }, SECRET)).toBe(false);
  });

  it("rejects when hmac is missing entirely", () => {
    expect(verifyOAuthCallbackHmac({ code: "abc123", shop: "x.myshopify.com" }, SECRET)).toBe(false);
  });

  it("ignores an extra `signature` param when building the message", () => {
    const params = { code: "abc123", shop: "x.myshopify.com", state: "xyz" };
    const hmac = sign(params);
    expect(verifyOAuthCallbackHmac({ ...params, signature: "irrelevant", hmac }, SECRET)).toBe(true);
  });
});
