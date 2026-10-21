import test from "node:test";
import assert from "node:assert/strict";
import { photoFeedback, reuploadDecision, heldPanelVisible, MAX_PHOTO_ATTEMPTS } from "./photoFeedback.ts";

const ok = (over = {}) => ({ ok: true, matched: true, confidence: 0.9, itemsMissing: [], notes: "", ...over });
const failed = (error) => ({ ok: false, matched: false, confidence: 0, itemsMissing: [], notes: "", error });

test("a passing verdict has nothing to explain", () => {
  assert.equal(photoFeedback({ verdict: "pass", confidence: 0.95, providers: [ok()] }), null);
  assert.equal(photoFeedback(null), null);
  assert.equal(photoFeedback({ verdict: null, providers: [] }), null);
});

test("no usable provider is OUR failure, not a finding about the photo", () => {
  // The exact #MOCK-9304 shape: every provider 400'd, so combine.ts returned
  // review @ 0 with "No AI provider returned a usable verdict". Telling the
  // florist their photo is "under review" there is simply untrue — nothing
  // reviewed it, and nothing was going to.
  const fb = photoFeedback({
    verdict: "review",
    confidence: 0,
    providers: [failed("400 image/jpeg vs image/webp"), failed("timeout")],
  });
  assert.equal(fb.code, "not_checked");
  assert.equal(fb.ourFault, true);
  assert.deepEqual(fb.missing, []);
});

test("a confident no-match reads as no_match and is not our fault", () => {
  const fb = photoFeedback({
    verdict: "fail",
    confidence: 0.9,
    providers: [ok({ matched: false, itemsMissing: ["Red roses x12"] })],
  });
  assert.equal(fb.code, "no_match");
  assert.equal(fb.ourFault, false);
  assert.deepEqual(fb.missing, ["Red roses x12"]);
});

test("a review with missing items reads as incomplete and lists them", () => {
  const fb = photoFeedback({
    verdict: "review",
    confidence: 0.8,
    providers: [ok({ itemsMissing: ["Eucalyptus", "Gift card"] })],
  });
  assert.equal(fb.code, "incomplete");
  assert.deepEqual(fb.missing, ["Eucalyptus", "Gift card"]);
});

test("a review with nothing specific missing reads as unsure", () => {
  const fb = photoFeedback({ verdict: "review", confidence: 0.4, providers: [ok({ confidence: 0.4 })] });
  assert.equal(fb.code, "unsure");
  assert.deepEqual(fb.missing, []);
});

test("missing items are deduped case-insensitively across providers and capped", () => {
  const fb = photoFeedback({
    verdict: "review",
    providers: [
      ok({ itemsMissing: ["Eucalyptus", "eucalyptus ", "Ribbon"] }),
      ok({ itemsMissing: ["EUCALYPTUS", "Vase", "A", "B", "C", "D", "E", "F"] }),
    ],
  });
  assert.equal(fb.missing.filter((m) => m.toLowerCase() === "eucalyptus").length, 1);
  assert.ok(fb.missing.length <= 6, `expected at most 6, got ${fb.missing.length}`);
});

test("a failed provider's itemsMissing never leaks into the explanation", () => {
  // An errored provider reports empty arrays anyway, but the filter is what
  // guarantees we never quote a provider that didn't actually see the photo.
  const fb = photoFeedback({
    verdict: "review",
    providers: [failed("boom"), ok({ itemsMissing: ["Eucalyptus"] })],
  });
  assert.deepEqual(fb.missing, ["Eucalyptus"]);
});

test("non-array / junk providers degrade to not_checked instead of throwing", () => {
  assert.equal(photoFeedback({ verdict: "review", providers: null }).code, "not_checked");
  assert.equal(photoFeedback({ verdict: "review", providers: "nope" }).code, "not_checked");
  assert.equal(photoFeedback({ verdict: "review", providers: [null, 3] }).code, "not_checked");
});

test("re-upload is allowed while the leg is held and attempts remain", () => {
  const d = reuploadDecision({ attempts: 1, payoutStatus: "held" });
  assert.equal(d.allowed, true);
  assert.equal(d.attemptsLeft, MAX_PHOTO_ATTEMPTS - 1);
});

test("re-upload stops once the attempt budget is spent", () => {
  const d = reuploadDecision({ attempts: MAX_PHOTO_ATTEMPTS, payoutStatus: "held" });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "no-attempts-left");
  assert.equal(d.attemptsLeft, 0);
});

test("money that already moved is final — no re-upload after issue/pay", () => {
  for (const status of ["issued", "paid", "pending"]) {
    const d = reuploadDecision({ attempts: 1, payoutStatus: status });
    assert.equal(d.allowed, false, status);
    assert.equal(d.reason, "already-paid", status);
  }
});

test("the first upload (no attempts, no payout row) is allowed", () => {
  const d = reuploadDecision({ attempts: 0, payoutStatus: null });
  assert.equal(d.allowed, true);
  assert.equal(d.attemptsLeft, MAX_PHOTO_ATTEMPTS);
});

test("a previously rejected (failed) leg does not block a fresh attempt", () => {
  assert.equal(reuploadDecision({ attempts: 1, payoutStatus: "failed" }).allowed, true);
});

// --- the held panel's visibility ---------------------------------------------
//
// Found in QA on 2026-08-20, right after the re-upload released the money: the
// panel still read "Your 30% releases once Facundo confirms the delivery
// photo. We'll let you know." The 30% had already been paid. `heldNotice` is
// set when an upload comes back held and never resets itself, so it outlived
// the condition it described.
test("a PAID delivery leg hides the panel even with stale client state", () => {
  for (const s of ["issued", "paid"]) {
    assert.equal(heldPanelVisible({ accepted: true, sessionHeldNotice: true, deliveryStatus: s }), false, s);
  }
});

test("a held leg shows the panel", () => {
  assert.equal(heldPanelVisible({ accepted: true, sessionHeldNotice: false, deliveryStatus: "held" }), true);
});

test("the in-session flag alone shows the panel before the server row lands", () => {
  // router.refresh() has not come back yet, so `payments` is a render behind.
  assert.equal(heldPanelVisible({ accepted: true, sessionHeldNotice: true, deliveryStatus: null }), true);
});

test("nothing shows before the order is accepted, or with no signal at all", () => {
  assert.equal(heldPanelVisible({ accepted: false, sessionHeldNotice: true, deliveryStatus: "held" }), false);
  assert.equal(heldPanelVisible({ accepted: true, sessionHeldNotice: false, deliveryStatus: null }), false);
});
