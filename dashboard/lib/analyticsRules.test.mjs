// Sanity assertions for the PostHog capture rules. These decide whether a
// person is recorded at all, so both failure directions are silent in
// production — hence the exception to the "barely any tests" non-goal.
//   node --test lib/analyticsRules.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseExcludedEmails, isExcludedEmail, replayAllowedOnHost } from "./analyticsRules.ts";

test("parseExcludedEmails tolerates spacing, casing and empty entries", () => {
  const set = parseExcludedEmails(" User@Example.com , teammate@x.com ,, ");
  assert.deepEqual([...set].sort(), ["teammate@x.com", "user@example.com"]);
});

test("parseExcludedEmails treats unset/blank as excluding nobody", () => {
  assert.equal(parseExcludedEmails(undefined).size, 0);
  assert.equal(parseExcludedEmails("").size, 0);
  assert.equal(parseExcludedEmails("  ,  ").size, 0);
});

test("isExcludedEmail matches case-insensitively and ignores surrounding space", () => {
  const set = parseExcludedEmails("user@example.com");
  assert.equal(isExcludedEmail("user@example.com", set), true);
  assert.equal(isExcludedEmail("  USER@Example.COM  ", set), true);
  // A real florist must never be swept up by the internal exclusion.
  assert.equal(isExcludedEmail("florist@example.com", set), false);
  // Substring collisions must not exclude a different person.
  assert.equal(isExcludedEmail("notuser@example.com", set), false);
  assert.equal(isExcludedEmail(undefined, set), false);
});

test("replayAllowedOnHost blocks dev and staging, allows production", () => {
  for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "mymac.local", "app.localhost"]) {
    assert.equal(replayAllowedOnHost(host), false, `${host} must not record`);
  }
  assert.equal(replayAllowedOnHost("facundo-staging.example.org"), false);
  assert.equal(replayAllowedOnHost("staging.example.com"), false);
  // Production is the only place replay is expected to run.
  assert.equal(replayAllowedOnHost("facundo.example.org"), true);
  assert.equal(replayAllowedOnHost("FACUNDO.example.org"), true);
});

test("replayAllowedOnHost fails closed on an empty host", () => {
  assert.equal(replayAllowedOnHost(""), false);
});
