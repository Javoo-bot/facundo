import test from "node:test";
import assert from "node:assert/strict";
import {
  MAGIC_TOKEN_TTL_DAYS,
  TEST_MODE_MAGIC_TOKEN,
  magicTokenExpiry,
  buildMagicUrl,
  isSafeDest,
  magicTokenBlockReason,
  loginFallbackPath,
  orderDest,
} from "./floristMagicLink.ts";

// Production-shaped token: florist_magic_tokens.token is a randomUUID().
const TOKEN = "9f8e7d6c-5b4a-4321-8765-0fedcba98765";
const NOW = new Date("2026-08-04T12:00:00.000Z");

const liveRow = {
  dest: "/florist/orders/a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789",
  expires_at: "2026-09-03T12:00:00.000Z",
  revoked_at: null,
};

test("magicTokenExpiry is exactly the documented TTL out", () => {
  const out = Date.parse(magicTokenExpiry(NOW));
  assert.equal(out - NOW.getTime(), MAGIC_TOKEN_TTL_DAYS * 24 * 3600 * 1000);
});

test("buildMagicUrl produces the /florist/m/<token> shape", () => {
  assert.equal(
    buildMagicUrl("https://florist.fc.example.net", TOKEN),
    `https://florist.fc.example.net/florist/m/${TOKEN}`
  );
});

test("a live token is redeemable", () => {
  assert.equal(magicTokenBlockReason(TOKEN, liveRow, NOW), null);
});

test("an unknown token is not-found", () => {
  assert.equal(magicTokenBlockReason(TOKEN, null, NOW), "not-found");
});

test("a revoked token is refused even before it expires", () => {
  const row = { ...liveRow, revoked_at: "2026-08-01T00:00:00.000Z" };
  assert.equal(magicTokenBlockReason(TOKEN, row, NOW), "revoked");
});

test("expiry is inclusive — a token expiring exactly now is already dead", () => {
  const row = { ...liveRow, expires_at: NOW.toISOString() };
  assert.equal(magicTokenBlockReason(TOKEN, row, NOW), "expired");
});

test("a token one second from expiry still works", () => {
  const row = { ...liveRow, expires_at: new Date(NOW.getTime() + 1000).toISOString() };
  assert.equal(magicTokenBlockReason(TOKEN, row, NOW), null);
});

// THE test-inbox guard. A test-mode send is redirected to the SHARED staff
// test inbox; this link is a LOGIN to a real shop. The sentinel must be
// refused even when a row exists for it and that row is otherwise perfect —
// i.e. the check must not be reachable-around via the database.
test("the test-mode sentinel is refused even with a live row behind it", () => {
  assert.equal(magicTokenBlockReason(TEST_MODE_MAGIC_TOKEN, liveRow, NOW), "sentinel");
  assert.equal(magicTokenBlockReason(TEST_MODE_MAGIC_TOKEN, null, NOW), "sentinel");
});

// A redirect is exactly the thing that must not trust its input.
test("isSafeDest accepts relative paths only", () => {
  assert.equal(isSafeDest("/florist/orders/abc"), true);
  assert.equal(isSafeDest("/florist"), true);

  assert.equal(isSafeDest("//evil.com"), false, "protocol-relative is an absolute URL to a browser");
  assert.equal(isSafeDest("https://evil.com"), false);
  assert.equal(isSafeDest("http://evil.com"), false);
  assert.equal(isSafeDest("javascript:alert(1)"), false);
  assert.equal(isSafeDest("florist/orders/abc"), false, "no leading slash");
  assert.equal(isSafeDest(""), false);
  assert.equal(isSafeDest(null), false);
  assert.equal(isSafeDest(undefined), false);
});

test("a row with an unsafe dest is refused rather than redirected to", () => {
  const row = { ...liveRow, dest: "//evil.com" };
  assert.equal(magicTokenBlockReason(TOKEN, row, NOW), "bad-dest");
});

// The whole point of the fallback: a dead link is a detour to sign-in, not a
// dead end that dumps the florist on the home screen.
test("loginFallbackPath preserves the destination through sign-in", () => {
  const path = loginFallbackPath("/florist/orders/abc", "expired");
  assert.equal(path, "/florist/login?next=%2Fflorist%2Forders%2Fabc&reason=expired");
});

test("loginFallbackPath refuses to carry an unsafe dest into the login page", () => {
  assert.equal(loginFallbackPath("//evil.com", "expired"), "/florist/login?next=%2Fflorist&reason=expired");
  assert.equal(loginFallbackPath(null, "not-found"), "/florist/login?next=%2Fflorist&reason=not-found");
});

test("orderDest matches the florist PWA's order route", () => {
  assert.equal(orderDest("a1b2c3d4"), "/florist/orders/a1b2c3d4");
});
