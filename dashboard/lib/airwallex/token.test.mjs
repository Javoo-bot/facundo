import test from "node:test";
import assert from "node:assert/strict";
import { jwtExpMs, tokenIsFresh, newTokenCache } from "./token.ts";

function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

test("jwtExpMs decodes the exp claim to ms", () => {
  assert.equal(jwtExpMs(makeJwt({ exp: 1_700_000_000 })), 1_700_000_000_000);
});

test("jwtExpMs returns null for non-JWT / no-exp / garbage", () => {
  assert.equal(jwtExpMs("not-a-jwt"), null);
  assert.equal(jwtExpMs("a.b"), null);
  assert.equal(jwtExpMs(makeJwt({ sub: "x" })), null); // no exp
  assert.equal(jwtExpMs("a.!!!notbase64json!!!.c"), null);
});

test("tokenIsFresh honours the skew window", () => {
  const now = 1_000_000;
  assert.equal(tokenIsFresh(null, now), false);
  assert.equal(tokenIsFresh({ token: "t", expMs: now + 120_000 }, now), true); // 2m left > 1m skew
  assert.equal(tokenIsFresh({ token: "t", expMs: now + 30_000 }, now), false); // 30s left < 1m skew
  assert.equal(tokenIsFresh({ token: "t", expMs: now - 1 }, now), false); // already expired
  assert.equal(tokenIsFresh({ token: "t", expMs: now + 5000 }, now, 1000), true); // custom skew
});

test("newTokenCache uses jwt exp when present", () => {
  const c = newTokenCache(makeJwt({ exp: 2_000 }), 0);
  assert.equal(c.expMs, 2_000_000);
});

test("newTokenCache falls back to a conservative TTL without exp", () => {
  const c = newTokenCache("opaque-token", 1_000, 60_000);
  assert.equal(c.expMs, 61_000);
});
