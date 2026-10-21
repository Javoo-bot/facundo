import test from "node:test";
import assert from "node:assert/strict";
import { coldFollowUpEligible, shouldResumeRecruiting, LIVE_OFFER_STATUSES } from "./liveOffer.ts";

// The bug this sweep exists to prevent: pauseRecruitingFor runs on every offer
// send, so without a resume the run parks at `paused` forever — and because the
// partial unique index counts `paused` as live, that florist can never be
// re-enrolled either. Recruiting dies silently for anyone ever offered an order.
test("a paused run resumes once no offer is live", () => {
  assert.equal(shouldResumeRecruiting([]), true, "no offers at all should resume");
  assert.equal(shouldResumeRecruiting(["declined"]), true);
  assert.equal(shouldResumeRecruiting(["expired", "declined"]), true);
  assert.equal(shouldResumeRecruiting(["reassigned", "released"]), true);
});

test("a run stays paused while any offer is still out", () => {
  for (const s of LIVE_OFFER_STATUSES) {
    assert.equal(shouldResumeRecruiting([s]), false, `${s} should hold the pause`);
    assert.equal(shouldResumeRecruiting(["declined", s]), false, `${s} alongside a dead one should hold`);
  }
});

// `accepted` counts as live on purpose: they are fulfilling an order right now,
// and "join our network" landing mid-delivery reads as nobody talking to anybody.
test("an accepted offer keeps recruiting paused", () => {
  assert.ok(LIVE_OFFER_STATUSES.includes("accepted"));
  assert.equal(shouldResumeRecruiting(["accepted"]), false);
});

// ---- the cold-offer follow-up ----

test("a shop that let the order go is followed up", () => {
  assert.equal(coldFollowUpEligible({ joined_at: null, excluded_at: null, deleted_at: null }), true);
  assert.equal(coldFollowUpEligible({}), true);
});

// They took it — they are in the network now, and the recruiting pitch would be
// telling someone who already works with us that we would like them to join.
test("a shop that took the order is never followed up", () => {
  assert.equal(coldFollowUpEligible({ joined_at: "2026-08-08T00:00:00Z" }), false);
});

test("excluded and deleted shops are never followed up", () => {
  assert.equal(coldFollowUpEligible({ excluded_at: "2026-01-01T00:00:00Z" }), false);
  assert.equal(coldFollowUpEligible({ deleted_at: "2026-01-01T00:00:00Z" }), false);
});

test("a missing florist row is not eligible, and does not throw", () => {
  assert.equal(coldFollowUpEligible(null), false);
  assert.equal(coldFollowUpEligible(undefined), false);
});
