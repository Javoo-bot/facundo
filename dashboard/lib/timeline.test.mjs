import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, earliestPendingFollowUp } from "./timeline.ts";

const outreach = [
  { id: "o1", florist_id: "f1", channel: "email", status: "sent", intended_address: "a@b.c",
    to_address: "t@e.st", test_mode: true, subject: "Hi", body: "Body",
    provider_message_id: "x", error: null, sent_by: "me", sent_at: "2026-07-01T11:00:00Z" },
];
const notes = [
  { id: "n1", florist_id: "f1", author: "Staff", body: "Replied", created_at: "2026-07-02T09:10:00Z" },
];
const meetings = [
  { id: "m1", florist_id: "f1", title: "Intro call", meeting_at: "2026-07-03T15:20:00Z",
    outcome: "Interested", next_follow_up_at: "2026-07-08T09:00:00Z", created_by: "me", created_at: "2026-07-03T15:25:00Z" },
];

test("buildTimeline merges all three, newest-first by `at`", () => {
  const tl = buildTimeline(outreach, notes, meetings);
  assert.equal(tl.length, 3);
  assert.deepEqual(tl.map((i) => i.type), ["meeting", "note", "email"]);
  assert.equal(tl[0].type === "meeting" && tl[0].title, "Intro call");
  assert.equal(tl[2].type === "email" && tl[2].subject, "Hi");
});

test("buildTimeline handles empty inputs", () => {
  assert.deepEqual(buildTimeline([], [], []), []);
});

test("earliestPendingFollowUp returns the soonest next_follow_up_at", () => {
  const two = [
    ...meetings,
    { id: "m2", florist_id: "f1", title: "Demo", meeting_at: "2026-07-04T10:00:00Z",
      outcome: null, next_follow_up_at: "2026-07-06T09:00:00Z", created_by: "me", created_at: "2026-07-04T10:05:00Z" },
  ];
  assert.equal(earliestPendingFollowUp(two)?.at, "2026-07-06T09:00:00Z");
  assert.equal(earliestPendingFollowUp([]), null);
  assert.equal(earliestPendingFollowUp([{ ...meetings[0], next_follow_up_at: null }]), null);
});
