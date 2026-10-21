import test from "node:test";
import assert from "node:assert/strict";
import { emailSkipReason, smsSkipReason, offerChannelAvailability, floristUnreachable, isShopSpecificSkip, SHOP_SPECIFIC_SKIP_REASONS } from "./offerChannels.ts";

// A florist who can be reached every way. Each test bends one field, so the
// assertions read as "this is the ONE thing that stopped it".
const ok = {
  offerEmailEnabled: true,
  floristSuppressed: false,
  smsOfferEnabled: true,
  smsIntended: "+34600111222",
  smsTo: "+34600111222",
  redirectToTestInbox: false,
  floristSmsSuppressed: false,
  suppressReason: null,
  smsSuppressReason: null,
  blockingError: null,
  emailIdentityProblem: null,
  smsUndeliverable: false,
};
const v = (over) => ({ ...ok, ...over });

test("email fires when nothing is in the way", () => {
  assert.equal(emailSkipReason(v()), null);
});

test("email: a configuration blocker outranks the softer reasons", () => {
  // blockingError is what the POST itself 400s on, so the dialog must show it
  // rather than a suppression note the send would never even reach.
  assert.equal(emailSkipReason(v({ blockingError: "no-test-email", floristSuppressed: true })), "no-test-email");
  assert.equal(emailSkipReason(v({ blockingError: "florist-no-email" })), "florist-no-email");
});

test("email: settings toggle, then opt-out vs snooze", () => {
  assert.equal(emailSkipReason(v({ offerEmailEnabled: false })), "disabled-by-settings");
  assert.equal(emailSkipReason(v({ floristSuppressed: true, suppressReason: "opted-out" })), "florist-opted-out");
  assert.equal(emailSkipReason(v({ floristSuppressed: true, suppressReason: "snoozed" })), "florist-snoozed");
});

test("email: unticked reads as not-selected, or as disabled when the toggle is off", () => {
  assert.equal(emailSkipReason(v(), false), "channel-not-selected");
  assert.equal(emailSkipReason(v({ offerEmailEnabled: false }), false), "disabled-by-settings");
});

test("sms fires when nothing is in the way", () => {
  assert.equal(smsSkipReason(v()), null);
});

// THE ORDER-DEPENDENT RULE, preserved from lib/reachoutSend.ts. A florist with
// no parseable number is unreachable whether or not test mode would have
// redirected the text elsewhere — otherwise test mode would report a shop as
// textable when live sending would not be.
test("sms: a missing florist number is reported ahead of any test-phone problem", () => {
  const noPhone = v({ smsIntended: null, redirectToTestInbox: true, smsTo: null });
  assert.equal(smsSkipReason(noPhone), "florist-no-sms-phone");
});

test("sms: the test-phone check keys off redirect, not test mode", () => {
  // A test SHOP texts its own number, so a missing global test phone must not
  // block it — the reason only appears when we are actually redirecting.
  assert.equal(smsSkipReason(v({ redirectToTestInbox: true, smsTo: null })), "no-test-phone");
  assert.equal(smsSkipReason(v({ redirectToTestInbox: false, smsTo: null })), null);
});

test("sms: settings toggle, then opt-out vs snooze", () => {
  assert.equal(smsSkipReason(v({ smsOfferEnabled: false })), "disabled-by-settings");
  assert.equal(smsSkipReason(v({ floristSmsSuppressed: true, smsSuppressReason: "opted-out" })), "florist-sms-opted-out");
  assert.equal(smsSkipReason(v({ floristSmsSuppressed: true, smsSuppressReason: "snoozed" })), "florist-sms-snoozed");
});

test("sms: unticked reads as not-selected, or as disabled when the toggle is off", () => {
  assert.equal(smsSkipReason(v(), false), "channel-not-selected");
  assert.equal(smsSkipReason(v({ smsOfferEnabled: false }), false), "disabled-by-settings");
});

test("availability reports all three channels, push from the subscription flag", () => {
  const all = offerChannelAvailability(v(), true);
  assert.deepEqual(all.map((c) => c.channel), ["email", "sms", "push"]);
  assert.ok(all.every((c) => c.available && c.reason === null));

  const noPush = offerChannelAvailability(v(), false).find((c) => c.channel === "push");
  assert.deepEqual(noPush, { channel: "push", available: false, reason: "no-push-subscription" });
});

test("availability carries the specific reason through, not just a boolean", () => {
  const out = offerChannelAvailability(v({ smsIntended: null, offerEmailEnabled: false }), false);
  assert.deepEqual(
    out.map((c) => [c.channel, c.available, c.reason]),
    [
      ["email", false, "disabled-by-settings"],
      ["sms", false, "florist-no-sms-phone"],
      ["push", false, "no-push-subscription"],
    ]
  );
});

// ---- The address on file is not this shop's (2026-08-06) -------------------
// A well-formed, deliverable address can still be the wrong one: ingest scrapes
// it from website_url, and for a shop whose "website" is its profile page on a
// network/franchise/directory site, that address is the head office's.

test("email: a network address is reported as such, not as a missing address", () => {
  assert.equal(emailSkipReason(v({ emailIdentityProblem: "network" })), "florist-email-is-network");
  assert.equal(emailSkipReason(v({ emailIdentityProblem: "shared" })), "florist-email-shared");
  assert.equal(emailSkipReason(v({ emailIdentityProblem: "bounced" })), "florist-email-bounced");
});

test("email: the wrong-address reason outranks an opt-out", () => {
  // When both apply, "we have the wrong address" is the one CX can act on — and
  // an opt-out recorded against an address that was never this shop's says
  // nothing about this shop.
  assert.equal(
    emailSkipReason(v({ emailIdentityProblem: "network", floristSuppressed: true, suppressReason: "opted-out" })),
    "florist-email-is-network"
  );
});

test("email: a configuration blocker still outranks the wrong-address reason", () => {
  assert.equal(
    emailSkipReason(v({ blockingError: "no-test-email", emailIdentityProblem: "network" })),
    "no-test-email"
  );
});

test("email: test-mode redirection does not excuse a wrong address", () => {
  // Same reasoning as florist-no-sms-phone below: test mode must report the
  // unreachability a live send would hit, not hide it behind the test inbox.
  assert.equal(
    emailSkipReason(v({ emailIdentityProblem: "network", redirectToTestInbox: true })),
    "florist-email-is-network"
  );
});

test("availability: a wrong address closes email but leaves SMS and push open", () => {
  // The whole point of the skip rather than a hard block — the shop is real and
  // its Maps-sourced phone number is its own.
  const rows = offerChannelAvailability(v({ emailIdentityProblem: "network" }), true);
  const by = Object.fromEntries(rows.map((r) => [r.channel, r]));
  assert.equal(by.email.available, false);
  assert.equal(by.email.reason, "florist-email-is-network");
  assert.equal(by.sms.available, true);
  assert.equal(by.push.available, true);
});

test("sms: a permanently undeliverable number is reported, ahead of the test-phone check", () => {
  assert.equal(smsSkipReason(v({ smsUndeliverable: true })), "florist-sms-undeliverable");
  // Test mode must report the same unreachability a live send would hit.
  assert.equal(
    smsSkipReason(v({ smsUndeliverable: true, redirectToTestInbox: true, smsTo: null })),
    "florist-sms-undeliverable"
  );
});

test("sms: a missing number still outranks a dead one — nothing to condemn", () => {
  assert.equal(smsSkipReason(v({ smsUndeliverable: true, smsIntended: null })), "florist-no-sms-phone");
});

test("availability: a dead number closes SMS but leaves email and push open", () => {
  const rows = offerChannelAvailability(v({ smsUndeliverable: true }), true);
  const by = Object.fromEntries(rows.map((r) => [r.channel, r]));
  assert.equal(by.sms.available, false);
  assert.equal(by.sms.reason, "florist-sms-undeliverable");
  assert.equal(by.email.available, true);
  assert.equal(by.push.available, true);
});

// --- Regression: a phone-only florist must still be reachable ---------------
// Order #2000020 (Vrbovec, HR) sent 2 offers and skipped 23. All 23 had working
// phone numbers; none got an SMS attempt, because reachoutSend treated
// `florist-no-email` as a whole-send abort — returning before the claim, the
// push leg and the SMS leg. Vrbovec has 37 florists and 5 websites, so email is
// the exception there; the abort made most of the market unreachable.

test("a missing email suppresses the email leg ONLY — SMS still fires", () => {
  const phoneOnly = v({ blockingError: "florist-no-email" });
  assert.equal(emailSkipReason(phoneOnly), "florist-no-email");
  assert.equal(smsSkipReason(phoneOnly), null, "SMS must be unaffected by the email leg's problem");
});

test("a missing email is the same shape as network/shared/bounced, which already hedged", () => {
  // These three always suppressed the email leg alone and let the offer hedge.
  // A shop that never had an address is the same case, not a misconfiguration.
  for (const identity of ["network", "shared", "bounced"]) {
    assert.equal(smsSkipReason(v({ emailIdentityProblem: identity })), null);
  }
  assert.equal(smsSkipReason(v({ blockingError: "florist-no-email" })), null);
});

test("offerChannelAvailability reports SMS available for a phone-only florist", () => {
  const avail = offerChannelAvailability(v({ blockingError: "florist-no-email" }));
  const sms = avail.find((c) => c.channel === "sms");
  const email = avail.find((c) => c.channel === "email");
  assert.equal(sms.available, true, "the confirm dialog must offer SMS to a phone-only shop");
  assert.equal(email.available, false);
  assert.equal(email.reason, "florist-no-email");
});

test("no-test-email still blocks every channel — it is OUR misconfiguration", () => {
  // The one blocking error that must keep aborting: test mode with nowhere to
  // redirect. Sending SMS live while email is redirected to a test inbox would
  // leak a real message out of test mode.
  const misconfigured = v({ blockingError: "no-test-email", redirectToTestInbox: true, smsTo: null });
  assert.equal(emailSkipReason(misconfigured), "no-test-email");
  assert.equal(smsSkipReason(misconfigured), "no-test-phone");
});

// reachoutSend.ts imports through "@/..." aliases, so plain `node --test`
// cannot load it (see this file's sibling reachoutSend.test.mjs for the same
// constraint). The abort condition is the whole fix, so assert it at the
// source level rather than not checking it at all — the repo uses this pattern
// for the matcher's lockstep guard too.
test("reachoutSend aborts only on no-test-email (source-level guard)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./reachoutSend.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /if \(r\.blockingError === "no-test-email"\) \{/,
    "the whole-send abort must be narrowed to no-test-email"
  );
  assert.ok(
    !/if \(r\.blockingError\) \{/.test(src),
    "a bare `if (r.blockingError)` abort would make phone-only florists unreachable again"
  );
});

// --- Regression: an offer that reached nobody must not count as sent --------
// Order #2000022 (Val-de-Moder, FR). Telnyx went out of funds mid-session: 12
// SMS failed, 3 had no number, and every one of those florists had no email and
// no push subscription. All 15 assignments were recorded `sent` having reached
// nobody — burning a live offer window each and telling the wave engine the
// florist was contacted.
//
// The guard lives in reachoutSend.ts (not importable under `node --test` — it
// uses "@/" aliases), so this asserts it at the source level, the same way the
// abort-condition guard above does.

test("sendOffer rolls back when no channel delivered (source-level guard)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./reachoutSend.ts", import.meta.url), "utf8");

  assert.match(src, /if \(!emailDelivered && !smsDelivered\) \{/, "must detect the all-legs-failed case");
  assert.match(src, /return \{ ok: false, error: "no-channel-delivered" \};/, "must report it rather than succeed");

  // The SMS result has to be observed. `.catch(() => {})` discarded it, which
  // is what made the failure invisible.
  assert.ok(!/\}\)\.catch\(\(\) => \{\}\);\s*\n\s*\}\s*\n\s*\/\/ Warm/.test(src), "the SMS result must not be discarded");
  assert.match(src, /smsDelivered = smsSent\.ok;/, "the SMS leg must record whether it delivered");

  // Ordering is load-bearing: the "offer went out" bookkeeping must come AFTER
  // the guard, or it fires for an offer that reached nobody.
  const guard = src.indexOf('if (!emailDelivered && !smsDelivered)');
  const statusWrite = src.indexOf('type: "outreach_sent"');
  const smsLeg = src.indexOf("smsDelivered = smsSent.ok;");
  assert.ok(guard > -1 && statusWrite > -1 && smsLeg > -1);
  assert.ok(smsLeg < guard, "the SMS leg must run before the guard decides");
  assert.ok(guard < statusWrite, "the guard must run before outreach_sent is recorded");
});

// ---------------------------------------------------------------------------
// floristUnreachable — "nothing was delivered": this shop's fault, or ours?
//
// The consequence of getting this wrong is asymmetric, which is why each case
// below is pinned. Say yes too easily and one provider outage burns every
// candidate on an order in a single tick; say no too easily and an order wedges
// forever retrying a shop we can never reach (QA/A2, order D).
// ---------------------------------------------------------------------------

test("floristUnreachable: a shop-specific block on the only live channel is unreachable", () => {
  // Order D exactly: the address is someone else's, and SMS is off for everyone
  // because no test phone is configured. The next shop's address may be fine,
  // so the list must move on.
  assert.equal(floristUnreachable("florist-email-shared", "no-test-phone"), true);
  assert.equal(floristUnreachable("florist-email-bounced", "no-test-phone"), true);
  assert.equal(floristUnreachable("florist-email-is-network", "no-test-phone"), true);
  assert.equal(floristUnreachable("florist-no-email", "florist-no-sms-phone"), true);
  assert.equal(floristUnreachable("florist-opted-out", "florist-sms-opted-out"), true);
});

test("floristUnreachable: an attempted channel that failed at the provider is NOT unreachable", () => {
  // null = the leg was actually tried and the provider failed. Val-de-Moder:
  // Telnyx ran out of funds mid-session. Skipping there would have spent all 15
  // candidates on an outage none of them could do anything about.
  assert.equal(floristUnreachable("florist-no-email", null), false);
  assert.equal(floristUnreachable(null, "florist-no-sms-phone"), false);
  assert.equal(floristUnreachable(null, null), false);
});

test("floristUnreachable: an all-environmental block is our outage, not the shop's", () => {
  // Offers switched off / no test address configured. Nothing about this shop
  // is wrong, and no other candidate would fare better — the order must sit and
  // escalate so a human fixes the setting, rather than eating the whole list.
  assert.equal(floristUnreachable("disabled-by-settings", "disabled-by-settings"), false);
  assert.equal(floristUnreachable("no-test-email", "no-test-phone"), false);
  assert.equal(floristUnreachable("channel-not-selected", "channel-not-selected"), false);
});

test("floristUnreachable: one shop-specific block is enough, whichever channel it is on", () => {
  // Email globally off, this shop has no number: unreachable *for us right now*,
  // while a shop that does have a number is still reachable. Skipping forward is
  // right, and only shops that also lack a number get skipped.
  assert.equal(floristUnreachable("disabled-by-settings", "florist-no-sms-phone"), true);
  assert.equal(floristUnreachable("no-test-email", "florist-sms-undeliverable"), true);
});

test("isShopSpecificSkip classifies every reason in the union exactly once", async () => {
  // Rot guard: a new ChannelSkipReason added to offerChannels.ts must be
  // consciously placed on one side or the other, not silently default to
  // "environmental" and quietly stop orders from skipping past a dead shop.
  const ENVIRONMENTAL = ["channel-not-selected", "disabled-by-settings", "no-test-email", "no-test-phone"];
  const all = [...SHOP_SPECIFIC_SKIP_REASONS, ...ENVIRONMENTAL];
  assert.equal(new Set(all).size, all.length, "no reason may appear on both sides");
  for (const r of ENVIRONMENTAL) assert.equal(isShopSpecificSkip(r), false, `${r} must be environmental`);
  for (const r of SHOP_SPECIFIC_SKIP_REASONS) assert.equal(isShopSpecificSkip(r), true, `${r} must be shop-specific`);
  assert.equal(isShopSpecificSkip(null), false);

  // Every member of the exported union is covered by one of the two lists.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./offerChannels.ts", import.meta.url), "utf8");
  const union = src.slice(src.indexOf("export type ChannelSkipReason"), src.indexOf("SHOP_SPECIFIC_SKIP_REASONS"));
  for (const m of union.matchAll(/\|\s*"([a-z-]+)"/g)) {
    assert.ok(all.includes(m[1]), `ChannelSkipReason "${m[1]}" is classified in neither list`);
  }
});

test("sendOffer distinguishes an unreachable shop from a failed send (source-level guard)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./reachoutSend.ts", import.meta.url), "utf8");

  // The all-legs-failed branch must consult the shared rule rather than growing
  // its own copy — the drift this module exists to prevent.
  assert.match(src, /floristUnreachable\(emailSkip, smsSkip\)/, "must classify via the shared predicate");
  assert.match(src, /error: "florist-unreachable"/, "must report the unreachable case distinctly");
  // ...and still report the transient case as before, so the wave engine keeps
  // retrying a provider outage instead of skipping past everyone.
  assert.match(src, /return \{ ok: false, error: "no-channel-delivered" \};/, "the transient case must survive");

  const classify = src.indexOf("floristUnreachable(emailSkip, smsSkip)");
  const rollback = src.indexOf("if (!emailDelivered && !smsDelivered)");
  assert.ok(rollback > -1 && classify > rollback, "classification belongs inside the all-legs-failed branch");
});

test("the wave engine skips an unreachable candidate instead of stalling the order (source-level guard)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./waves.ts", import.meta.url), "utf8");

  // QA/A2 order D: `stuck++; continue` moved to the next ORDER, leaving this one
  // retrying the same unreachable shop every minute forever and never reaching
  // rank 2. The walk must close the dead candidate and try the next rank.
  assert.match(src, /r\.error === "florist-unreachable"/, "must recognise the unreachable result");
  assert.match(src, /continue; \/\/ next candidate, same order/, "must advance within the order, not to the next order");
  assert.match(src, /type: "offer_skipped"/, "a skip must leave an audit trail");

  // The close is CAS-guarded, or a racing staff send gets closed out from under it.
  const skipBlock = src.slice(src.indexOf('r.error === "florist-unreachable"'), src.indexOf("next candidate, same order"));
  assert.match(skipBlock, /\.in\("status", \["candidate", "queued"\]\)/, "closing the candidate must be CAS-guarded");

  // A transient failure must NOT walk on — that is the provider-outage case.
  assert.match(src, /if \(r\.error !== "not-sendable"\) stuck\+\+;/, "transient failures still count as stuck");
  const transient = src.indexOf('if (r.error !== "not-sendable") stuck++;');
  const skip = src.indexOf('r.error === "florist-unreachable"');
  assert.ok(skip > -1 && transient > skip, "the unreachable branch must be checked before the catch-all");
});
