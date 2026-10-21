import test from "node:test";
import assert from "node:assert/strict";
import {
  isHumanEngagement,
  ENGAGED_THEN_SILENT_REASON,
  HUMAN_CLICK_MIN_DELAY_MS,
  photoVerdictAttentionReasons,
} from "./cxAttentionRules.ts";

const DELIVERED = "2026-09-10T10:27:12.482Z";
const after = (ms) => new Date(Date.parse(DELIVERED) + ms).toISOString();

// Order #2000034, as recorded in production: offer delivered 10:27:12 UTC,
// clicked 11:34:29 and 11:39:01, portal never opened (opened_at null).
test("isHumanEngagement recognises the order #2000034 florist", () => {
  assert.equal(
    isHumanEngagement({
      openedAt: null,
      clicks: [
        { clickedAt: "2026-09-10T11:34:29.725Z", deliveredAt: DELIVERED },
        { clickedAt: "2026-09-10T11:39:01.131Z", deliveredAt: DELIVERED },
      ],
    }),
    true
  );
});

test("a portal visit always counts — a scanner does not sign in", () => {
  assert.equal(isHumanEngagement({ openedAt: "2026-09-10T10:27:57Z", clicks: [] }), true);
});

// Security scanners follow every link within seconds of delivery. Those
// clicks must not put an order on the desk as "a florist is interested".
test("a click within a minute of delivery is treated as a scanner", () => {
  assert.equal(isHumanEngagement({ openedAt: null, clicks: [{ clickedAt: after(3_000), deliveredAt: DELIVERED }] }), false);
  assert.equal(isHumanEngagement({ openedAt: null, clicks: [{ clickedAt: after(HUMAN_CLICK_MIN_DELAY_MS - 1), deliveredAt: DELIVERED }] }), false);
  assert.equal(isHumanEngagement({ openedAt: null, clicks: [{ clickedAt: after(HUMAN_CLICK_MIN_DELAY_MS), deliveredAt: DELIVERED }] }), true);
});

test("one scanner click does not hide a later human one", () => {
  assert.equal(
    isHumanEngagement({
      openedAt: null,
      clicks: [
        { clickedAt: after(2_000), deliveredAt: DELIVERED },
        { clickedAt: after(40 * 60_000), deliveredAt: DELIVERED },
      ],
    }),
    true
  );
});

test("without a delivery receipt a click cannot be told from a scanner, so it does not count", () => {
  assert.equal(isHumanEngagement({ openedAt: null, clicks: [{ clickedAt: after(3_600_000), deliveredAt: null }] }), false);
});

test("no evidence, or unparseable evidence, is not engagement", () => {
  assert.equal(isHumanEngagement({ openedAt: null, clicks: [] }), false);
  assert.equal(isHumanEngagement({ openedAt: null, clicks: [{ clickedAt: "garbage", deliveredAt: DELIVERED }] }), false);
  assert.equal(isHumanEngagement({ openedAt: null, clicks: [{ clickedAt: after(3_600_000), deliveredAt: "garbage" }] }), false);
});

test("the reason ranks above a cold wave and below a true dead end", () => {
  assert.equal(ENGAGED_THEN_SILENT_REASON.category, "place");
  assert.ok(ENGAGED_THEN_SILENT_REASON.urgency > 85, "should outrank 'Needs next florist' (85)");
  assert.ok(ENGAGED_THEN_SILENT_REASON.urgency < 90, "should not outrank 'No florist left in range' (90)");
});

// Hawkeye's photo-verdict hold stopped parking the payout on 2026-08-20
// (lib/payoutHold.ts), so a `review`/`fail` verdict is recorded but nothing
// else tells a human to look at it. These rules are what closes that gap in
// gatherAttention — card #55fc7df0.
test("a review verdict surfaces its order, flagged for a human", () => {
  const out = photoVerdictAttentionReasons([
    { assignmentId: "a1", orderId: "o1", verdict: "review", createdAt: "2026-10-13T17:53:23Z" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].orderId, "o1");
  assert.equal(out[0].reason.category, "delivery");
});

test("a fail verdict surfaces too, and outranks a mere review", () => {
  const review = photoVerdictAttentionReasons([
    { assignmentId: "a1", orderId: "o1", verdict: "review", createdAt: "2026-10-13T17:53:23Z" },
  ]);
  const fail = photoVerdictAttentionReasons([
    { assignmentId: "a2", orderId: "o2", verdict: "fail", createdAt: "2026-10-13T17:53:23Z" },
  ]);
  assert.ok(fail[0].reason.urgency > review[0].reason.urgency);
});

test("a pass verdict never surfaces", () => {
  const out = photoVerdictAttentionReasons([
    { assignmentId: "a1", orderId: "o1", verdict: "pass", createdAt: "2026-10-13T17:53:23Z" },
  ]);
  assert.equal(out.length, 0);
});

// Re-upload (lib/photoFeedback.ts) can still happen with the hold disabled —
// e.g. a leg held for an unrelated reason (tier-hold). Only the MOST RECENT
// verdict per assignment should count: a later clean photo clears an earlier
// bad one, the same rule the florist-facing retry flow already honours.
test("a later pass on the same assignment clears an earlier review", () => {
  const out = photoVerdictAttentionReasons([
    { assignmentId: "a1", orderId: "o1", verdict: "review", createdAt: "2026-10-13T10:00:00Z" },
    { assignmentId: "a1", orderId: "o1", verdict: "pass", createdAt: "2026-10-13T11:00:00Z" },
  ]);
  assert.equal(out.length, 0);
});

test("a later fail on the same assignment still flags, even after an earlier pass", () => {
  const out = photoVerdictAttentionReasons([
    { assignmentId: "a1", orderId: "o1", verdict: "pass", createdAt: "2026-10-13T10:00:00Z" },
    { assignmentId: "a1", orderId: "o1", verdict: "fail", createdAt: "2026-10-13T11:00:00Z" },
  ]);
  assert.equal(out.length, 1);
});

test("two different assignments are judged independently", () => {
  const out = photoVerdictAttentionReasons([
    { assignmentId: "a1", orderId: "o1", verdict: "review", createdAt: "2026-10-13T10:00:00Z" },
    { assignmentId: "a2", orderId: "o2", verdict: "pass", createdAt: "2026-10-13T10:00:00Z" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].orderId, "o1");
});
