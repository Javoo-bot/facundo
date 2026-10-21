import test from "node:test";
import assert from "node:assert/strict";
import {
  warmth, rankCallTargets, pickSubject, nextAfter, isColdLead, isCallTarget, noSubjectReason,
  buildHistory, historySummary, offerSignal, offerLine, uncallableReason,
  canDeclineInPlace, CALL_DECLINE_REASONS, DECLINABLE_STATUSES, CALL_DECLINABLE_STATUSES,
  callBackGapMinutes, inCallCooldown, lastCallLine, CALL_BACK_GAP_MIN,
} from "./callCard.ts";

/** A candidate with everything null; spread over it to set only what a test cares about. */
function cand(over = {}) {
  return {
    assignmentId: "a", floristId: "f", rank: 1, status: "sent", withdrawnAt: null,
    payoutPrice: 59, declineReason: null, declineDetail: null, declinedAt: null,
    name: "Shop", phone: "+33 1 00 00 00 00", ownerName: null, lifecycleStage: "found",
    rating: null, reviewCount: null, address: null, distanceKm: null,
    lastNoAnswerAt: null, noAnswerCount: 0,
    sentAt: null, deliveredAt: null, openedAt: null, clickedAt: null, signedInAt: null,
    ...over,
  };
}

const T = "2026-08-17T10:00:00Z";
const fmt = () => "Mon 17 Aug";

// ---------------------------------------------------------------------------
// Warmth and ranking
// ---------------------------------------------------------------------------

test("warmth climbs with how far they got into the offer", () => {
  assert.equal(warmth(cand()), 0);
  assert.equal(warmth(cand({ deliveredAt: T })), 1);
  assert.equal(warmth(cand({ deliveredAt: T, openedAt: T })), 2);
  assert.equal(warmth(cand({ deliveredAt: T, openedAt: T, clickedAt: T })), 3);
  assert.equal(warmth(cand({ signedInAt: T })), 4);
});

test("a shop that already said no is off the list entirely", () => {
  // They have given us their answer. Ringing them back to ask again is the one
  // call that must never be suggested — and with the payout fixed there is no
  // lever left to change their mind with, so it could only annoy them. Even a
  // decliner who opened and signed in does not appear.
  const decliner = cand({ assignmentId: "no", status: "declined", clickedAt: T, signedInAt: T });
  const silent = cand({ assignmentId: "quiet" });
  assert.ok(warmth(decliner) < warmth(silent));
  assert.deepEqual(rankCallTargets([decliner, silent]).map((c) => c.assignmentId), ["quiet"]);
});

test("only shops we actually asked, and who have not answered, can be called", () => {
  // "Sent the email and has not rejected it" — limbo, and nothing else.
  for (const status of ["sent", "opened", "expired"]) {
    assert.equal(isCallTarget(cand({ status })), true, `${status} should be callable`);
  }
  // Holds the order: a different call ("how is it going"), still theirs to take.
  for (const status of ["accepted", "delivered"]) {
    assert.equal(isCallTarget(cand({ status })), true, `${status} should be callable`);
  }
  // Never contacted — there is no offer to ring about.
  for (const status of ["candidate", "queued"]) {
    assert.equal(isCallTarget(cand({ status })), false, `${status} must not be callable`);
  }
  // Answered, or we took it back.
  for (const status of ["declined", "reassigned", "released"]) {
    assert.equal(isCallTarget(cand({ status })), false, `${status} must not be callable`);
  }
});

test("a shop nobody has emailed yet never reaches the card", () => {
  const untouched = cand({ assignmentId: "fresh", status: "candidate" });
  const asked = cand({ assignmentId: "asked", status: "expired" });
  assert.deepEqual(rankCallTargets([untouched, asked]).map((c) => c.assignmentId), ["asked"]);
});

test("an order everyone refused leaves nobody to call", () => {
  const ranked = rankCallTargets([
    cand({ assignmentId: "a", status: "declined" }),
    cand({ assignmentId: "b", status: "declined" }),
  ]);
  assert.deepEqual(ranked, []);
  assert.equal(pickSubject(ranked), null);
});

test("the empty card says which kind of empty it is", () => {
  const refused = noSubjectReason(["declined", "declined", "expired"]);
  assert.match(refused, /All 2 shops/);
  assert.match(refused, /turned this order down/);

  assert.match(noSubjectReason(["declined"]), /The one shop/);

  // Asked nobody yet is a different problem, and must not read as a refusal.
  const unasked = noSubjectReason(["candidate", "candidate"]);
  assert.match(unasked, /has to go out first/);
  assert.doesNotMatch(unasked, /turned this order down/);

  assert.match(noSubjectReason([]), /no one on the other end of a phone/);
});

test("ties break on distance, then on the original match rank", () => {
  const far = cand({ assignmentId: "far", openedAt: T, distanceKm: 9 });
  const near = cand({ assignmentId: "near", openedAt: T, distanceKm: 1 });
  const noCoords = cand({ assignmentId: "nowhere", openedAt: T, distanceKm: null, rank: 2 });
  const noCoords2 = cand({ assignmentId: "nowhere2", openedAt: T, distanceKm: null, rank: 1 });
  assert.deepEqual(
    rankCallTargets([far, noCoords, near, noCoords2]).map((c) => c.assignmentId),
    ["near", "far", "nowhere2", "nowhere"],
  );
});

test("a withdrawn offer is off the table and never appears", () => {
  const gone = cand({ assignmentId: "gone", clickedAt: T, withdrawnAt: T });
  const here = cand({ assignmentId: "here" });
  assert.deepEqual(rankCallTargets([gone, here]).map((c) => c.assignmentId), ["here"]);
});

test("ranking does not mutate the array it is given", () => {
  const input = [cand({ assignmentId: "b" }), cand({ assignmentId: "a", clickedAt: T })];
  const before = input.map((c) => c.assignmentId);
  rankCallTargets(input);
  assert.deepEqual(input.map((c) => c.assignmentId), before);
});

// ---------------------------------------------------------------------------
// Who the card is about
// ---------------------------------------------------------------------------

test("once somebody has accepted, they are the subject however cold they look", () => {
  const holder = cand({ assignmentId: "holder", status: "accepted" });
  const warmer = cand({ assignmentId: "warmer", clickedAt: T, signedInAt: T });
  const ranked = rankCallTargets([warmer, holder]);
  assert.equal(pickSubject(ranked)?.assignmentId, "holder");
  // …and an explicit pick cannot override that — the call is now about the
  // order being fulfilled, not about finding a shop.
  assert.equal(pickSubject(ranked, "warmer")?.assignmentId, "holder");
});

test("otherwise the operator's explicit pick wins, else the warmest", () => {
  const ranked = rankCallTargets([cand({ assignmentId: "cold" }), cand({ assignmentId: "hot", clickedAt: T })]);
  assert.equal(pickSubject(ranked)?.assignmentId, "hot");
  assert.equal(pickSubject(ranked, "cold")?.assignmentId, "cold");
  assert.equal(pickSubject(ranked, "nonexistent")?.assignmentId, "hot");
  assert.equal(pickSubject([]), null);
});

test("nextAfter walks the ranked list and stops at the end", () => {
  const ranked = rankCallTargets([
    cand({ assignmentId: "1", clickedAt: T }),
    cand({ assignmentId: "2", openedAt: T }),
  ]);
  assert.equal(nextAfter(ranked, "1")?.assignmentId, "2");
  assert.equal(nextAfter(ranked, "2"), null);
  assert.equal(nextAfter(ranked, "missing"), null);
});

// ---------------------------------------------------------------------------
// History — the rule that a lapsed offer is not a refusal
// ---------------------------------------------------------------------------

function row(over = {}) {
  return {
    assignmentId: "h", orderId: "o", orderName: "#1", status: "expired",
    declineReason: null, declineDetail: null, declinedAt: null, deliveredAt: null, ...over,
  };
}

test("an offer that lapsed is NOT counted as a refusal", () => {
  // The whole point: silence means nobody was at the keyboard. Counting it as
  // a "no" would make every busy shop look like a serial rejector.
  const h = buildHistory([row(), row({ assignmentId: "h2" }), row({ assignmentId: "h3", status: "candidate" })]);
  assert.equal(h.refusals.length, 0);
  assert.equal(h.completed, 0);
  assert.equal(historySummary(h), "No completed orders · no refusals");
});

test("an active decline counts even when they gave no reason", () => {
  const h = buildHistory([
    row({ assignmentId: "r1", status: "declined", declineReason: "Price too low", declinedAt: "2026-08-17T10:25:00Z" }),
    row({ assignmentId: "r2", status: "declined", declineReason: null, declinedAt: "2026-08-10T09:00:00Z" }),
    row({ assignmentId: "e", status: "expired" }),
  ]);
  assert.equal(h.refusals.length, 2);
  assert.equal(h.refusals[0].reason, "Price too low", "newest refusal first");
  assert.equal(h.refusals[1].reason, null);
  assert.equal(historySummary(h), "No completed orders · 2 refusals");
});

test("completed means delivered — an accepted-but-undelivered order is not one yet", () => {
  const h = buildHistory([
    row({ assignmentId: "d", status: "delivered" }),
    row({ assignmentId: "a", status: "accepted" }),
  ]);
  assert.equal(h.completed, 1);
  assert.equal(historySummary(h), "1 completed order · no refusals");
});

test("summary singularises both halves", () => {
  const h = buildHistory([
    row({ assignmentId: "d", status: "delivered" }),
    row({ assignmentId: "r", status: "declined", declinedAt: T }),
  ]);
  assert.equal(historySummary(h), "1 completed order · 1 refusal");
});

// ---------------------------------------------------------------------------
// What the screen says about this offer — facts, never instructions
// ---------------------------------------------------------------------------

test("offerSignal reads the furthest stage, with a decline outranking all of it", () => {
  assert.equal(offerSignal(cand()), "unsent");
  assert.equal(offerSignal(cand({ sentAt: T })), "sent");
  assert.equal(offerSignal(cand({ sentAt: T, deliveredAt: T })), "delivered");
  assert.equal(offerSignal(cand({ openedAt: T })), "opened");
  assert.equal(offerSignal(cand({ clickedAt: T })), "clicked");
  assert.equal(offerSignal(cand({ signedInAt: T })), "signed_in");
  assert.equal(offerSignal(cand({ clickedAt: T, status: "declined" })), "declined");
});

test("every offer line is a statement of fact, with no imperative verb", () => {
  const lines = [
    offerLine(cand(), fmt),
    offerLine(cand({ sentAt: T }), fmt),
    offerLine(cand({ deliveredAt: T }), fmt),
    offerLine(cand({ openedAt: T }), fmt),
    offerLine(cand({ clickedAt: T }), fmt),
    offerLine(cand({ signedInAt: T }), fmt),
    offerLine(cand({ status: "declined", declineReason: "Too busy", declinedAt: T }), fmt),
    offerLine(cand({ status: "declined", declinedAt: T }), fmt),
  ];
  // The screen reports; it does not coach. Guard against the advice creeping
  // back in — it was on this card once and was cut for being worthless.
  const coaching = /\b(ask|open with|don't|do not|try|sell|push|remind|tell them|start)\b/i;
  for (const l of lines) {
    assert.ok(l.length > 0);
    assert.ok(!coaching.test(l), `line reads as instruction, not fact: ${l}`);
  }
  assert.match(lines[6], /Too busy/);
  assert.match(lines[7], /without giving a reason/);
});

test("a shop with no number says why it cannot be called", () => {
  assert.equal(uncallableReason(cand()), null);
  assert.match(String(uncallableReason(cand({ phone: null }))), /No phone number/);
});

test("cold lead is anything not yet in production", () => {
  assert.equal(isColdLead("found"), true);
  assert.equal(isColdLead("onboarding"), true);
  assert.equal(isColdLead("production"), false);
});

// ---------------------------------------------------------------------------
// Recording the outcome
// ---------------------------------------------------------------------------

test("the call's decline reasons are exactly the florist-facing six", () => {
  // Same codes, same spelling, same order as
  // components/florist/FloristOrderDetail.tsx::REASONS. If these drift, the
  // same objection gets counted under two names in opsStats.
  assert.deepEqual([...CALL_DECLINE_REASONS], [
    "Price too low", "Too busy", "Out of area", "Can't source", "Too urgent", "On holiday",
  ]);
});

test("a refusal taken on the phone lands on a lapsed offer too", () => {
  for (const s of ["candidate", "queued", "sent", "opened"]) {
    assert.equal(canDeclineInPlace(s), true, s);
  }
  // The usual case for a shop worth phoning, and the reason this set is not
  // just the reachout guard: without it the refusal reached an events row and
  // nothing else, so the call list kept offering the same shop back.
  assert.equal(canDeclineInPlace("expired"), true);

  // Already answered, holding the order, or taken back by us — nothing to write.
  for (const s of ["declined", "accepted", "delivered", "released", "reassigned"]) {
    assert.equal(canDeclineInPlace(s), false, s);
  }
});

test("the phone set is the reachout guard plus lapsed offers, and nothing else", () => {
  // DECLINABLE_STATUSES still mirrors OPEN_STATUSES in the reachout route: a
  // self-service decline on a lapsed offer is a race and must still lose.
  assert.deepEqual([...DECLINABLE_STATUSES], ["candidate", "queued", "sent", "opened"]);
  assert.deepEqual([...CALL_DECLINABLE_STATUSES], [...DECLINABLE_STATUSES, "expired"]);
});

test("a shop refused by phone drops off the call list", () => {
  // The end-to-end point of the change: the refusal now lands on the
  // assignment, and rankCallTargets reads the assignment.
  const before = cand({ assignmentId: "shop", status: "expired", openedAt: T });
  assert.deepEqual(rankCallTargets([before]).map((c) => c.assignmentId), ["shop"]);

  const after = cand({ assignmentId: "shop", status: "declined", openedAt: T });
  assert.deepEqual(rankCallTargets([after]), []);
  assert.equal(pickSubject(rankCallTargets([after])), null);
});

// ---------------------------------------------------------------------------
// Calling back after nobody picked up
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-02T12:00:00Z");
const inHours = (h) => new Date(NOW + h * 3600e3).toISOString();
const minsAgo = (m) => new Date(NOW - m * 60e3).toISOString();

test("how long to leave a shop alone tracks how urgent the order is", () => {
  // Same tiers as the offer window, because it is the same judgement: how much
  // time is there to be patient with.
  assert.equal(callBackGapMinutes(inHours(3), CALL_BACK_GAP_MIN, NOW), CALL_BACK_GAP_MIN.rush);
  assert.equal(callBackGapMinutes(inHours(20), CALL_BACK_GAP_MIN, NOW), CALL_BACK_GAP_MIN.sameday);
  assert.equal(callBackGapMinutes(inHours(48), CALL_BACK_GAP_MIN, NOW), CALL_BACK_GAP_MIN.standard);
  assert.equal(callBackGapMinutes(inHours(96), CALL_BACK_GAP_MIN, NOW), CALL_BACK_GAP_MIN.far);
  assert.equal(callBackGapMinutes(null, CALL_BACK_GAP_MIN, NOW), CALL_BACK_GAP_MIN.noDate);
  assert.equal(callBackGapMinutes("not a date", CALL_BACK_GAP_MIN, NOW), CALL_BACK_GAP_MIN.noDate);
  // A rush order is rung back sooner than a distant one — the whole point.
  assert.ok(callBackGapMinutes(inHours(3), CALL_BACK_GAP_MIN, NOW) < callBackGapMinutes(inHours(96), CALL_BACK_GAP_MIN, NOW));
});

test("a shop we just rang is on cooldown; one we rang long ago is not", () => {
  const rush = inHours(3); // 10 minute gap
  assert.equal(inCallCooldown({ lastNoAnswerAt: minsAgo(4) }, rush, CALL_BACK_GAP_MIN, NOW), true);
  assert.equal(inCallCooldown({ lastNoAnswerAt: minsAgo(30) }, rush, CALL_BACK_GAP_MIN, NOW), false);
  // Never rung is never on cooldown, and a broken timestamp must not become one.
  assert.equal(inCallCooldown({ lastNoAnswerAt: null }, rush, CALL_BACK_GAP_MIN, NOW), false);
  assert.equal(inCallCooldown({ lastNoAnswerAt: "nonsense" }, rush, CALL_BACK_GAP_MIN, NOW), false);
});

test("a just-rung shop sorts below an untried one, however warm it is", () => {
  const rush = inHours(3);
  // The warm shop was rung four minutes ago; the cold one has never been tried.
  const justRung = cand({ assignmentId: "rung", status: "opened", openedAt: T, lastNoAnswerAt: minsAgo(4), noAnswerCount: 1 });
  const untried = cand({ assignmentId: "fresh", status: "sent" });
  assert.deepEqual(
    rankCallTargets([justRung, untried], { deliveryAt: rush, now: NOW }).map((c) => c.assignmentId),
    ["fresh", "rung"],
  );
  // Once the cooldown lapses, warmth decides again.
  const later = cand({ assignmentId: "rung", status: "opened", openedAt: T, lastNoAnswerAt: minsAgo(45), noAnswerCount: 1 });
  assert.deepEqual(
    rankCallTargets([later, untried], { deliveryAt: rush, now: NOW }).map((c) => c.assignmentId),
    ["rung", "fresh"],
  );
});

test("everyone on cooldown still yields a shop, never an empty card", () => {
  const rush = inHours(3);
  const a = cand({ assignmentId: "a", status: "sent", lastNoAnswerAt: minsAgo(2), noAnswerCount: 1 });
  const b = cand({ assignmentId: "b", status: "sent", lastNoAnswerAt: minsAgo(3), noAnswerCount: 1 });
  const ranked = rankCallTargets([a, b], { deliveryAt: rush, now: NOW });
  // An empty screen would be a worse answer than a judgement call — the
  // operator gets the best shop plus the line saying when it was last rung.
  assert.equal(ranked.length, 2);
  assert.ok(pickSubject(ranked) !== null);
});

test("the card says when we last rang, so a second operator does not repeat it", () => {
  assert.equal(lastCallLine({ lastNoAnswerAt: null, noAnswerCount: 0 }, NOW), null);
  assert.match(lastCallLine({ lastNoAnswerAt: minsAgo(20), noAnswerCount: 1 }, NOW), /20 minutes ago/);
  assert.match(lastCallLine({ lastNoAnswerAt: minsAgo(1), noAnswerCount: 1 }, NOW), /1 minute ago/);
  assert.match(lastCallLine({ lastNoAnswerAt: minsAgo(180), noAnswerCount: 1 }, NOW), /3 hours ago/);
  // Repeat attempts are counted, so persistence is visible rather than guessed.
  assert.match(lastCallLine({ lastNoAnswerAt: minsAgo(20), noAnswerCount: 2 }, NOW), /This is call 3/);
  assert.doesNotMatch(lastCallLine({ lastNoAnswerAt: minsAgo(20), noAnswerCount: 1 }, NOW), /This is call/);
});

test("omitting the delivery time keeps the old ordering exactly", () => {
  // Existing callers pass no delivery time; nobody is on cooldown for them.
  const rung = cand({ assignmentId: "rung", status: "opened", openedAt: T, lastNoAnswerAt: minsAgo(1), noAnswerCount: 1 });
  const untried = cand({ assignmentId: "fresh", status: "sent" });
  assert.deepEqual(rankCallTargets([rung, untried]).map((c) => c.assignmentId), ["rung", "fresh"]);
});

test("the desk's own gaps win, and a half-written settings row cannot switch the cooldown off", () => {
  const rush = inHours(3);
  // A desk that wants to be far more patient on rush orders.
  const theirs = { rush: 120, sameday: 120, standard: 120, far: 120, noDate: 120 };
  assert.equal(callBackGapMinutes(rush, theirs, NOW), 120);
  assert.equal(inCallCooldown({ lastNoAnswerAt: minsAgo(60) }, rush, theirs, NOW), true);
  // Same shop, shipped defaults: an hour is well past the 10-minute gap.
  assert.equal(inCallCooldown({ lastNoAnswerAt: minsAgo(60) }, rush, CALL_BACK_GAP_MIN, NOW), false);

  // A null column must fall back to the shipped number, not to zero — zero would
  // silently disable the cooldown and look like the feature was never built.
  assert.equal(callBackGapMinutes(rush, { rush: null }, NOW), CALL_BACK_GAP_MIN.rush);
  assert.equal(callBackGapMinutes(rush, null, NOW), CALL_BACK_GAP_MIN.rush);
  assert.equal(callBackGapMinutes(rush, {}, NOW), CALL_BACK_GAP_MIN.rush);
});
