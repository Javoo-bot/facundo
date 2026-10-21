import test from "node:test";
import assert from "node:assert/strict";
import { encodeActingClaim, decodeActingClaim } from "./floristActingToken.ts";

const SECRET = "test-secret-not-the-real-one";
const OTHER = "a-different-secret";
const claim = { floristId: "f-123", userId: "u-456", exp: Date.now() + 60_000 };

test("a claim survives a round trip intact", () => {
  const back = decodeActingClaim(encodeActingClaim(claim, SECRET), SECRET);
  assert.deepEqual(back, claim);
});

test("a claim signed with another secret is refused", () => {
  // The whole point: a florist cannot mint one, because they do not have this.
  assert.equal(decodeActingClaim(encodeActingClaim(claim, OTHER), SECRET), null);
});

test("editing the shop id invalidates the signature", () => {
  // The attack this exists to stop: point the cookie at somebody else's shop
  // and read their orders.
  const token = encodeActingClaim(claim, SECRET);
  const [body, sig] = token.split(".");
  const tampered = Buffer.from(
    JSON.stringify({ ...claim, floristId: "f-someone-else" }),
  ).toString("base64url");
  assert.equal(decodeActingClaim(`${tampered}.${sig}`, SECRET), null);
});

test("malformed tokens are refused rather than throwing", () => {
  for (const bad of ["", ".", "nodot", "a.", ".b", "not.base64!!", "a.b.c"]) {
    assert.equal(decodeActingClaim(bad, SECRET), null, JSON.stringify(bad));
  }
  assert.equal(decodeActingClaim(null, SECRET), null);
  assert.equal(decodeActingClaim(undefined, SECRET), null);
  assert.equal(decodeActingClaim(42, SECRET), null);
});

test("a claim missing any field is refused", () => {
  // A half-written claim must not resolve to a shop by accident.
  for (const partial of [
    { userId: "u", exp: 1 },
    { floristId: "f", exp: 1 },
    { floristId: "f", userId: "u" },
    { floristId: 1, userId: "u", exp: 1 },
    {},
  ]) {
    const body = Buffer.from(JSON.stringify(partial)).toString("base64url");
    // Sign it properly, so only the SHAPE check can reject it.
    const token = encodeActingClaim(partial, SECRET);
    assert.equal(decodeActingClaim(token, SECRET), null, JSON.stringify(partial));
    assert.ok(body.length > 0);
  }
});

test("expiry is left to the caller, so this stays time-pure", () => {
  // Decoding an expired claim still returns it; lib/floristActing.ts is what
  // compares exp against the clock. Keeping the split means this file needs no
  // frozen time to test.
  const expired = { ...claim, exp: Date.now() - 60_000 };
  const back = decodeActingClaim(encodeActingClaim(expired, SECRET), SECRET);
  assert.deepEqual(back, expired);
  assert.ok(back.exp < Date.now());
});
