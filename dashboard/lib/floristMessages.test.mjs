import test from "node:test";
import assert from "node:assert/strict";
import { mergeMessageList, unreadTotal, isMessageKind } from "./floristMessages.ts";

const issue = (id, unread, created, assignment = "a1") => ({
  id,
  florist_unread: unread,
  created_at: created,
  assignment_id: assignment,
});
const msg = (id, unread, created) => ({ id, florist_unread: unread, created_at: created });

test("unread rows come before read ones regardless of age", () => {
  const out = mergeMessageList(
    [issue("i1", false, "2026-08-05T12:00:00Z")],
    [msg("m1", true, "2026-01-01T00:00:00Z")]
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["m1", "i1"]
  );
});

test("within a group, newest first", () => {
  const out = mergeMessageList(
    [issue("i1", true, "2026-08-01T00:00:00Z"), issue("i2", true, "2026-08-03T00:00:00Z")],
    [msg("m1", true, "2026-08-02T00:00:00Z")]
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["i2", "m1", "i1"]
  );
});

test("neither source is pinned above the other — a live order issue can outrank a welcome", () => {
  const out = mergeMessageList(
    [issue("i1", true, "2026-08-05T10:00:00Z")],
    [msg("m1", true, "2026-08-04T10:00:00Z")]
  );
  assert.equal(out[0].id, "i1");
});

test("each source gets its own destination", () => {
  const out = mergeMessageList([issue("i1", true, "2026-08-01T00:00:00Z", "asg9")], [msg("m1", true, "2026-08-02T00:00:00Z")]);
  const byId = Object.fromEntries(out.map((r) => [r.id, r.href]));
  assert.equal(byId.i1, "/florist/orders/asg9");
  assert.equal(byId.m1, "/florist/messages/m1");
});

test("an issue whose assignment was cleared falls back to the florist home", () => {
  const out = mergeMessageList([issue("i1", true, "2026-08-01T00:00:00Z", null)], []);
  assert.equal(out[0].href, "/florist");
});

test("an unparseable timestamp sorts oldest rather than to the top", () => {
  const out = mergeMessageList(
    [issue("bad", true, "not a date"), issue("good", true, "2026-08-01T00:00:00Z")],
    []
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["good", "bad"]
  );
});

test("either source may be empty", () => {
  assert.equal(mergeMessageList([], []).length, 0);
  assert.equal(mergeMessageList([issue("i1", true, "2026-08-01T00:00:00Z")], []).length, 1);
  assert.equal(mergeMessageList([], [msg("m1", true, "2026-08-01T00:00:00Z")]).length, 1);
});

test("unreadTotal counts both sources and treats a failed count as zero", () => {
  assert.equal(unreadTotal(2, 1), 3);
  assert.equal(unreadTotal(null, 1), 1);
  assert.equal(unreadTotal(2, null), 2);
  assert.equal(unreadTotal(null, null), 0);
});

test("isMessageKind only accepts known kinds", () => {
  assert.equal(isMessageKind("welcome"), true);
  assert.equal(isMessageKind("nope"), false);
  assert.equal(isMessageKind(undefined), false);
});
