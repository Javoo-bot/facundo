import { test } from "node:test";
import assert from "node:assert/strict";
import { needsNewJoinToken, joinTokenExpiry, buildJoinUrl } from "./floristJoin.ts";

test("needs a token when none is set", () => {
  const result = needsNewJoinToken({ join_token: null, join_token_expires_at: null, joined_at: null }, new Date());
  assert.equal(result, true);
});

test("does not need a new token while the current one is still live", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const future = new Date("2026-09-01T00:00:00Z").toISOString();
  const result = needsNewJoinToken({ join_token: "abc", join_token_expires_at: future, joined_at: null }, now);
  assert.equal(result, false);
});

test("needs a new token once the current one has expired", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const past = new Date("2026-07-01T00:00:00Z").toISOString();
  const result = needsNewJoinToken({ join_token: "abc", join_token_expires_at: past, joined_at: null }, now);
  assert.equal(result, true);
});

test("never re-mints for a florist who already joined, even past expiry", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const past = new Date("2026-07-01T00:00:00Z").toISOString();
  const result = needsNewJoinToken(
    { join_token: "abc", join_token_expires_at: past, joined_at: "2026-07-15T00:00:00Z" },
    now
  );
  assert.equal(result, false);
});

test("joinTokenExpiry is 30 days out from the given instant", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const expiry = new Date(joinTokenExpiry(now));
  const diffDays = (expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(diffDays, 30);
});

test("buildJoinUrl joins origin and token under /florist/accept", () => {
  assert.equal(buildJoinUrl("https://facundo.app", "abc123"), "https://facundo.app/florist/accept/abc123");
});
