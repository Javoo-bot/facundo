import { test } from "node:test";
import assert from "node:assert/strict";

// The token helper reads its secret at call time from the env — set it before import.
process.env.PROOF_SECRET = "test-proof-secret";
const { signProofToken, verifyProofToken, buildProofUrl } = await import("./photoToken.ts");

const KEY = "orders/abc/delivered-xyz.jpg";
const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 10;

function sigFrom(qs) {
  return decodeURIComponent(new URLSearchParams(qs).get("sig"));
}

test("sign → verify round-trips for a valid, unexpired token", () => {
  const exp = future();
  const sig = sigFrom(signProofToken(KEY, exp));
  assert.equal(verifyProofToken(KEY, exp, sig), true);
});

test("verify rejects an expired token", () => {
  const exp = past();
  const sig = sigFrom(signProofToken(KEY, exp));
  assert.equal(verifyProofToken(KEY, exp, sig), false);
});

test("verify rejects a tampered key", () => {
  const exp = future();
  const sig = sigFrom(signProofToken(KEY, exp));
  assert.equal(verifyProofToken("orders/abc/delivered-OTHER.jpg", exp, sig), false);
});

test("verify rejects a tampered expiry (sig no longer matches)", () => {
  const exp = future();
  const sig = sigFrom(signProofToken(KEY, exp));
  assert.equal(verifyProofToken(KEY, exp + 999, sig), false);
});

test("verify rejects a garbage signature", () => {
  assert.equal(verifyProofToken(KEY, future(), "not-a-real-sig"), false);
});

test("buildProofUrl produces an absolute /api/orders/proof URL that verifies", () => {
  const url = buildProofUrl("https://app.example.com/", KEY);
  assert.ok(url.startsWith("https://app.example.com/api/orders/proof?"));
  const qs = url.split("?")[1];
  const p = new URLSearchParams(qs);
  assert.equal(verifyProofToken(decodeURIComponent(p.get("key")), Number(p.get("exp")), decodeURIComponent(p.get("sig"))), true);
});

test("no secret configured → no token (feature is a graceful no-op)", async () => {
  delete process.env.PROOF_SECRET;
  delete process.env.OUTBOX_SECRET;
  const fresh = await import("./photoToken.ts?nosecret");
  assert.equal(fresh.signProofToken(KEY, future()), null);
  assert.equal(fresh.buildProofUrl("https://x.example.com", KEY), null);
  process.env.PROOF_SECRET = "test-proof-secret"; // restore for any later run
});
