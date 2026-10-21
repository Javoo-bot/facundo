import test from "node:test";
import assert from "node:assert/strict";
import {
  generateShortCode,
  isShortCode,
  buildShortUrl,
  collidesWithStaffRoute,
  SHORT_CODE_LENGTH,
  SHORT_CODE_RE,
} from "./shortLink.ts";
import { STAFF_SEGMENTS } from "./hostRouting.ts";

test("codes are exactly SHORT_CODE_LENGTH base62 chars", () => {
  for (let i = 0; i < 200; i++) {
    const c = generateShortCode();
    assert.equal(c.length, SHORT_CODE_LENGTH);
    assert.match(c, SHORT_CODE_RE);
  }
});

test("isShortCode accepts a real code and rejects everything else", () => {
  assert.equal(isShortCode(generateShortCode()), true);
  for (const bad of [
    "", "short", "a".repeat(9), "a".repeat(11),
    "abcdefgh-i", "abcdefgh/i", "abcdefgh.i", "ABCDEFG H",
    null, undefined,
  ]) {
    assert.equal(isShortCode(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

// The code fronts a login. Modulo bias would quietly cost entropy on the
// symbols an attacker would guess first, so assert the distribution directly.
test("no modulo bias — all 62 symbols appear with roughly equal frequency", () => {
  const counts = new Map();
  const N = 4000;
  for (let i = 0; i < N; i++) {
    for (const ch of generateShortCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  assert.equal(counts.size, 62, "every base62 symbol should occur");
  const expected = (N * SHORT_CODE_LENGTH) / 62;
  for (const [ch, n] of counts) {
    assert.ok(
      n > expected * 0.6 && n < expected * 1.4,
      `symbol ${ch} appeared ${n} times, expected ~${Math.round(expected)}`
    );
  }
});

test("buildShortUrl root-mounts the code without a double slash", () => {
  assert.equal(
    buildShortUrl("https://bo.fc.example.net", "aB3xK9mQ2p"),
    "https://bo.fc.example.net/aB3xK9mQ2p"
  );
  assert.equal(
    buildShortUrl("https://bo.fc.example.net/", "aB3xK9mQ2p"),
    "https://bo.fc.example.net/aB3xK9mQ2p"
  );
});

// The whole design rests on this length: 36 chars is what the segment budget
// was measured against (lib/offerSmsContent.test.mjs pins the consequence).
test("a real short URL is 36 characters", () => {
  assert.equal(buildShortUrl("https://bo.fc.example.net", generateShortCode()).length, 36);
});

// Codes sit at the SITE ROOT, so one equal to a staff segment would be shadowed
// by that page and the link would be permanently dead. Two staff segments are
// exactly 10 base62 chars today, so this is real, not hypothetical.
test("staff-segment collisions are rejected — and two really are 10 base62 chars", () => {
  const tenCharSegments = [...STAFF_SEGMENTS].filter((seg) => /^[0-9A-Za-z]{10}$/.test(seg));
  assert.deepEqual(tenCharSegments.sort(), ["operations", "statistics"],
    "if this changed, the collision surface changed — re-check the guard");
  for (const seg of tenCharSegments) {
    assert.equal(collidesWithStaffRoute(seg), true, `${seg} must be rejected as a code`);
  }
  assert.equal(collidesWithStaffRoute(generateShortCode()), false);
});
