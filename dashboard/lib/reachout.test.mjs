import test from "node:test";
import assert from "node:assert/strict";
import {
  nextSendableCandidate,
  suggestedTimeoutMinutes,
  canSend,
  liveOfferExists,
  isResendable,
  orderResendable,
  resendBlockReason,
  RESENDABLE_STATUSES,
  DEFAULT_OFFER_WINDOWS,
  renotifyBlockReason,
  isRenotifiable,
  allowedChannels,
  OFFER_CHANNELS,
  RENOTIFY_COOLDOWN_MS,
} from "./reachout.ts";

const a = (over) => ({ id: "x", status: "candidate", rank: 1, ...over });

test("next sendable = lowest-rank candidate/queued, skipping sent/declined/accepted", () => {
  const list = [a({ id: "1", rank: 1, status: "declined" }), a({ id: "2", rank: 2, status: "candidate" }), a({ id: "3", rank: 3, status: "queued" })];
  assert.equal(nextSendableCandidate(list)?.id, "2");
});

test("no sendable candidate returns null", () => {
  assert.equal(nextSendableCandidate([a({ status: "accepted" })]), null);
});

test("timeout shrinks with urgency", () => {
  const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
  const far = new Date(Date.now() + 72 * 3600e3).toISOString();
  assert.ok(suggestedTimeoutMinutes(soon) < suggestedTimeoutMinutes(far));
});

const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

test("suggestedTimeoutMinutes honours custom tiers from settings", () => {
  const w = { rushMin: 5, samedayMin: 10, standardMin: 20, farMin: 40, noDateMin: 25 };
  assert.equal(suggestedTimeoutMinutes(inHours(2), w), 5);
  assert.equal(suggestedTimeoutMinutes(inHours(12), w), 10);
  assert.equal(suggestedTimeoutMinutes(inHours(48), w), 20);
  assert.equal(suggestedTimeoutMinutes(inHours(200), w), 40);
  assert.equal(suggestedTimeoutMinutes(null, w), 25);
});

test("suggestedTimeoutMinutes falls back to the shipped ladder when no windows are passed", () => {
  assert.equal(suggestedTimeoutMinutes(inHours(2)), 15);
  assert.equal(suggestedTimeoutMinutes(inHours(12)), 30);
  assert.equal(suggestedTimeoutMinutes(inHours(48)), 60);
  assert.equal(suggestedTimeoutMinutes(inHours(200)), 120);
  assert.equal(suggestedTimeoutMinutes(null), 60);
});

test("DEFAULT_OFFER_WINDOWS matches the migration's column defaults", () => {
  assert.deepEqual(DEFAULT_OFFER_WINDOWS, {
    rushMin: 15, samedayMin: 30, standardMin: 60, farMin: 120, noDateMin: 60,
  });
});

test("canSend blocks nothing extra in test/step; a null candidate can't send", () => {
  assert.equal(canSend(a({ status: "candidate" }), "test"), true);
  assert.equal(canSend(a({ status: "sent" }), "step"), false);
});

test("liveOfferExists true when any candidate is sent/opened", () => {
  assert.equal(liveOfferExists([a({ status: "sent" })]), true);
  assert.equal(liveOfferExists([a({ status: "declined" })]), false);
});

// ---------------------------------------------------------------------------
// isResendable / orderResendable / resendBlockReason
// ---------------------------------------------------------------------------

const OPEN_ORDER = "reaching_out";
const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
const pastExpiry = new Date(nowMs - 60_000).toISOString();
const futureExpiry = new Date(nowMs + 60_000).toISOString();

test("orderResendable: allows received/matched/reaching_out/escalated with no deleted_at", () => {
  for (const s of ["received", "matched", "reaching_out", "escalated"]) {
    assert.equal(orderResendable(s, null), true, s);
  }
});

test("orderResendable: blocks accepted..closed, cancelled, and any deleted_at", () => {
  for (const s of ["accepted", "in_production", "ready", "out_for_delivery", "delivered", "paid", "closed", "cancelled"]) {
    assert.equal(orderResendable(s, null), false, s);
  }
  assert.equal(orderResendable("reaching_out", "2026-07-01T00:00:00.000Z"), false);
});

// Every one of the 10 order_assignments.status values, per spec §A.1.
test("isResendable classifies every assignment status correctly (order open, no expiry ambiguity)", () => {
  const cases = [
    ["candidate", null, false],
    ["queued", null, false],
    ["sent", pastExpiry, true],
    ["sent", futureExpiry, false],
    ["sent", null, false], // fail closed — un-expirable, 409 must point at Decline
    ["opened", pastExpiry, true],
    ["opened", futureExpiry, false],
    ["opened", null, false],
    ["declined", null, true],
    ["expired", null, true],
    ["accepted", null, false],
    ["reassigned", null, false],
    ["released", null, false],
    ["delivered", null, false],
  ];
  for (const [status, offer_expires_at, expected] of cases) {
    assert.equal(
      isResendable({ status, offer_expires_at }, OPEN_ORDER, null, nowMs),
      expected,
      `${status} / expires=${offer_expires_at}`
    );
  }
});

test("isResendable: expiry boundary — exactly now is NOT past (strict <), one ms later is", () => {
  const exactlyNow = new Date(nowMs).toISOString();
  assert.equal(isResendable({ status: "sent", offer_expires_at: exactlyNow }, OPEN_ORDER, null, nowMs), false);
  const oneMsPast = new Date(nowMs - 1).toISOString();
  assert.equal(isResendable({ status: "sent", offer_expires_at: oneMsPast }, OPEN_ORDER, null, nowMs), true);
});

test("isResendable: expiry boundary applies identically to 'opened' (its exact sibling of 'sent')", () => {
  const exactlyNow = new Date(nowMs).toISOString();
  assert.equal(isResendable({ status: "opened", offer_expires_at: exactlyNow }, OPEN_ORDER, null, nowMs), false);
  const oneMsPast = new Date(nowMs - 1).toISOString();
  assert.equal(isResendable({ status: "opened", offer_expires_at: oneMsPast }, OPEN_ORDER, null, nowMs), true);
});

test("isResendable: order-level gate blocks an otherwise-resendable assignment", () => {
  const declined = { status: "declined", offer_expires_at: null };
  assert.equal(isResendable(declined, OPEN_ORDER, null, nowMs), true);
  for (const closedStatus of ["accepted", "in_production", "delivered", "paid", "closed"]) {
    assert.equal(isResendable(declined, closedStatus, null, nowMs), false, closedStatus);
  }
  assert.equal(isResendable(declined, "cancelled", null, nowMs), false);
  assert.equal(isResendable(declined, OPEN_ORDER, "2026-07-01T00:00:00.000Z", nowMs), false);
});

test("isResendable: escalated order is allowed", () => {
  assert.equal(isResendable({ status: "declined", offer_expires_at: null }, "escalated", null, nowMs), true);
});

test("resendBlockReason: returns the specific reason, or null exactly when isResendable is true", () => {
  assert.equal(resendBlockReason({ status: "candidate", offer_expires_at: null }, OPEN_ORDER, null, nowMs), "not-sent-yet");
  assert.equal(resendBlockReason({ status: "queued", offer_expires_at: null }, OPEN_ORDER, null, nowMs), "not-sent-yet");
  assert.equal(resendBlockReason({ status: "accepted", offer_expires_at: null }, OPEN_ORDER, null, nowMs), "already-accepted");
  for (const s of ["reassigned", "released", "delivered"]) {
    assert.equal(resendBlockReason({ status: s, offer_expires_at: null }, OPEN_ORDER, null, nowMs), "assignment-closed");
  }
  assert.equal(resendBlockReason({ status: "sent", offer_expires_at: futureExpiry }, OPEN_ORDER, null, nowMs), "still-live");
  assert.equal(resendBlockReason({ status: "sent", offer_expires_at: null }, OPEN_ORDER, null, nowMs), "still-live");
  assert.equal(resendBlockReason({ status: "declined", offer_expires_at: null }, "closed", null, nowMs), "order-not-open");
  assert.equal(resendBlockReason({ status: "declined", offer_expires_at: null }, "cancelled", null, nowMs), "order-cancelled");
  assert.equal(resendBlockReason({ status: "declined", offer_expires_at: null }, OPEN_ORDER, "2026-07-01T00:00:00.000Z", nowMs), "order-deleted");
  assert.equal(resendBlockReason({ status: "declined", offer_expires_at: null }, OPEN_ORDER, null, nowMs), null);

  for (const s of RESENDABLE_STATUSES) {
    const expiry = s === "sent" || s === "opened" ? pastExpiry : null;
    assert.equal(
      resendBlockReason({ status: s, offer_expires_at: expiry }, OPEN_ORDER, null, nowMs) === null,
      isResendable({ status: s, offer_expires_at: expiry }, OPEN_ORDER, null, nowMs)
    );
  }
});

test("RESENDABLE_STATUSES excludes candidate/queued (they use the plain Send action)", () => {
  assert.deepEqual([...RESENDABLE_STATUSES].sort(), ["declined", "expired", "opened", "sent"].sort());
});

// ---------------------------------------------------------------------------
// renotifyBlockReason — re-delivering a LIVE offer (lib/reachoutRenotify.ts)
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const future = new Date(NOW + 30 * 60_000).toISOString();
const past = new Date(NOW - 30 * 60_000).toISOString();
const rn = (over, orderStatus = "reaching_out", deletedAt = null, lastSent = null, now = NOW) =>
  renotifyBlockReason({ status: "sent", offer_expires_at: future, ...over }, orderStatus, deletedAt, lastSent, now);

test("renotify: a live sent/opened offer is re-deliverable", () => {
  assert.equal(rn({ status: "sent" }), null);
  assert.equal(rn({ status: "opened" }), null);
});

test("renotify: a NULL expiry counts as live, so no state is orphaned between the two actions", () => {
  // resendBlockReason fails CLOSED on a null expiry ("still-live"), so if
  // renotify treated it as lapsed the row would be rejected by BOTH predicates
  // and no action could ever reach it.
  assert.equal(rn({ status: "sent", offer_expires_at: null }), null);
});

test("renotify: a lapsed offer is NOT re-deliverable — that's Re-send's job", () => {
  assert.equal(rn({ status: "sent", offer_expires_at: past }), "not-live");
  assert.equal(rn({ status: "opened", offer_expires_at: past }), "not-live");
});

test("renotify: states owned by other actions are rejected", () => {
  for (const status of ["candidate", "queued", "declined", "expired", "accepted", "reassigned", "released", "delivered"]) {
    assert.equal(rn({ status }), "not-live", `${status} must not be re-deliverable`);
  }
});

test("renotify: order-level gates match the resend rules", () => {
  assert.equal(rn({}, "reaching_out", "2026-08-05T00:00:00Z"), "order-deleted");
  assert.equal(rn({}, "cancelled"), "order-cancelled");
  assert.equal(rn({}, "delivered"), "order-not-open");
});

test("renotify: per-channel cooldown blocks only inside the window", () => {
  const justNow = new Date(NOW - 30_000).toISOString();
  const longAgo = new Date(NOW - RENOTIFY_COOLDOWN_MS - 1000).toISOString();
  assert.equal(rn({}, "reaching_out", null, justNow), "cooling-down");
  assert.equal(rn({}, "reaching_out", null, longAgo), null);
  // Exactly at the boundary the cooldown has elapsed.
  assert.equal(rn({}, "reaching_out", null, new Date(NOW - RENOTIFY_COOLDOWN_MS).toISOString()), null);
  // Unparseable timestamps must not block forever.
  assert.equal(rn({}, "reaching_out", null, "not-a-date"), null);
  assert.equal(isRenotifiable({ status: "sent", offer_expires_at: future }, "reaching_out", null, null, NOW), true);
});

test("renotify and resend PARTITION the state space — exactly one owns each state", () => {
  // The load-bearing invariant: every assignment state is reachable by exactly
  // one of the two actions, so neither can silently claim the other's case and
  // no state is stranded with no action at all.
  const statuses = ["candidate", "queued", "sent", "opened", "declined", "expired", "accepted", "reassigned", "released", "delivered"];
  for (const status of statuses) {
    for (const expires of [future, past, null]) {
      // Swept over the withdrawal too: a withdrawn offer must still be owned by
      // exactly one action, never stranded (which is the bug below).
      for (const withdrawn of [null, "2026-08-05T09:00:32.373Z"]) {
        const asg = { status, offer_expires_at: expires, withdrawn_at: withdrawn };
        const canResend = resendBlockReason(asg, "reaching_out", null, NOW) === null;
        const canRenotify = renotifyBlockReason(asg, "reaching_out", null, null, NOW) === null;
        assert.ok(!(canResend && canRenotify), `${status}/${expires}/w=${withdrawn} is claimed by BOTH actions`);
        if (status === "sent" || status === "opened") {
          assert.ok(canResend || canRenotify, `${status}/${expires}/w=${withdrawn} is claimed by NEITHER action`);
        }
      }
    }
  }
});

// REGRESSION (production, order #2000018 / assignment c057eb38). Staff withdrew
// a live offer, then kept using "Send again" with a fresh window. Re-notify
// changes no state, so `withdrawn_at` survived every click — while its
// `resetWindow` pushed `offer_expires_at` back into the future, which kept
// resendBlockReason answering "still-live" and so kept the Re-send button (the
// ONLY action that clears the withdrawal) permanently hidden. The florist got
// real offer emails for an offer lib/lateAccept.ts would never let them accept.
test("a withdrawn offer is resendable regardless of expiry, and never re-notifiable", () => {
  const withdrawnLive = { status: "sent", offer_expires_at: future, withdrawn_at: "2026-08-05T09:00:32.373Z" };

  // Without the withdrawal this is the textbook "still-live" case...
  assert.equal(
    resendBlockReason({ ...withdrawnLive, withdrawn_at: null }, "reaching_out", null, NOW),
    "still-live"
  );
  // ...but withdrawn, Re-send must be reachable — it's the way back.
  assert.equal(resendBlockReason(withdrawnLive, "reaching_out", null, NOW), null);

  // And "Send again" must refuse: re-delivering an offer the florist cannot
  // accept is exactly what produced the silent dead end.
  assert.equal(renotifyBlockReason(withdrawnLive, "reaching_out", null, null, NOW), "not-live");
  assert.equal(
    renotifyBlockReason({ ...withdrawnLive, withdrawn_at: null }, "reaching_out", null, null, NOW),
    null
  );

  // Holds for `opened` and for a lapsed window too.
  for (const status of ["sent", "opened"]) {
    for (const expires of [future, past, null]) {
      const asg = { status, offer_expires_at: expires, withdrawn_at: "2026-08-05T09:00:32.373Z" };
      assert.equal(resendBlockReason(asg, "reaching_out", null, NOW), null, `${status}/${expires}`);
      assert.equal(renotifyBlockReason(asg, "reaching_out", null, null, NOW), "not-live", `${status}/${expires}`);
    }
  }
});

test("allowedChannels intersects the request with the settings gates", () => {
  const all = OFFER_CHANNELS;
  assert.deepEqual(allowedChannels(all, { emailEnabled: true, smsEnabled: true }), ["email", "sms", "push"]);
  assert.deepEqual(allowedChannels(all, { emailEnabled: false, smsEnabled: true }), ["sms", "push"]);
  assert.deepEqual(allowedChannels(all, { emailEnabled: true, smsEnabled: false }), ["email", "push"]);
  // Push has no settings gate — it is best-effort and costs nothing.
  assert.deepEqual(allowedChannels(["push"], { emailEnabled: false, smsEnabled: false }), ["push"]);
  // A narrower request is never widened by the gates.
  assert.deepEqual(allowedChannels(["email"], { emailEnabled: true, smsEnabled: true }), ["email"]);
  assert.deepEqual(allowedChannels([], { emailEnabled: true, smsEnabled: true }), []);
});
