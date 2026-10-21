// Unit tests for the "view as florist" cookie signing — the security-critical
// bit: a tampered or wrong-secret token must never decode to a valid claim.
//   node --test lib/viewAsToken.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeClaim, decodeClaim } from "./viewAsToken.ts";

const SECRET = "test-secret-abc";
const claim = { floristId: "flor-1", staffEmail: "ops@x.io", exp: 1_800_000_000_000 };

test("round-trips a claim with the right secret", () => {
  const token = encodeClaim(claim, SECRET);
  assert.deepEqual(decodeClaim(token, SECRET), claim);
});

test("rejects a token signed with a different secret", () => {
  const token = encodeClaim(claim, SECRET);
  assert.equal(decodeClaim(token, "other-secret"), null);
});

test("rejects a tampered body (signature no longer matches)", () => {
  const token = encodeClaim(claim, SECRET);
  const [body, sig] = token.split(".");
  // Flip the claim to a different florist, keep the old signature.
  const forgedBody = Buffer.from(
    JSON.stringify({ ...claim, floristId: "flor-999" })
  ).toString("base64url");
  assert.equal(decodeClaim(`${forgedBody}.${sig}`, SECRET), null);
  // Sanity: the original still verifies.
  assert.ok(decodeClaim(`${body}.${sig}`, SECRET));
});

test("rejects malformed tokens", () => {
  assert.equal(decodeClaim("", SECRET), null);
  assert.equal(decodeClaim("no-dot", SECRET), null);
  assert.equal(decodeClaim(".sigonly", SECRET), null);
  assert.equal(decodeClaim("bodyonly.", SECRET), null);
});

test("rejects a well-signed token whose body isn't a valid claim shape", () => {
  // Sign a structurally-wrong payload with the correct secret.
  const badToken = encodeClaim({ floristId: "f", staffEmail: 42, exp: 1 }, SECRET);
  assert.equal(decodeClaim(badToken, SECRET), null);
});

test("decode does not enforce expiry (caller's job) — an expired claim still decodes", () => {
  const expired = { ...claim, exp: 1 };
  const token = encodeClaim(expired, SECRET);
  assert.deepEqual(decodeClaim(token, SECRET), expired);
});
