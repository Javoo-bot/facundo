import test from "node:test";
import assert from "node:assert/strict";
import { openStateOf, openStateOfRun, gateAllows } from "./openState.ts";
import { isGenuineOpen, MIN_HUMAN_OPEN_DELAY_MS } from "./openQuality.ts";

const DELIVERED = "2026-09-09T09:00:00.000Z";
const at = (msAfter) => new Date(Date.parse(DELIVERED) + msAfter).toISOString();

// ---- openQuality: keeping Apple/Gmail prefetch out of the branch ----
//
// Measured on prod the day this shipped: 1,560 `opened` against 1,068
// `delivered`. More opens than deliveries — that surplus is machines, and at a
// 3.5-hour gate it would otherwise be the majority of the signal.

test("an open moments after delivery is prefetch, not a reader", () => {
  assert.equal(isGenuineOpen({ deliveredAt: DELIVERED, openedAt: at(0) }), false);
  assert.equal(isGenuineOpen({ deliveredAt: DELIVERED, openedAt: at(30_000) }), false);
  assert.equal(
    isGenuineOpen({ deliveredAt: DELIVERED, openedAt: at(MIN_HUMAN_OPEN_DELAY_MS - 1) }),
    false,
    "the threshold is exclusive on the wrong side"
  );
});

test("an open a couple of minutes later is a person", () => {
  assert.equal(isGenuineOpen({ deliveredAt: DELIVERED, openedAt: at(MIN_HUMAN_OPEN_DELAY_MS) }), true);
  assert.equal(isGenuineOpen({ deliveredAt: DELIVERED, openedAt: at(5 * 60_000) }), true);
});

test("two opens beat the timing rule — prefetch fires once", () => {
  assert.equal(
    isGenuineOpen({ deliveredAt: DELIVERED, openedAt: at(2_000), openCount: 2 }),
    true,
    "a shop that came back to the mail was scored as a machine"
  );
});

test("a human click settles it outright", () => {
  assert.equal(isGenuineOpen({ deliveredAt: DELIVERED, openedAt: at(1_000), hasHumanClick: true }), true);
});

test("openQuality fails CLOSED where clickQuality fails open", () => {
  // No delivery timestamp = no evidence. clickQuality treats that as human,
  // because discarding a real click abandons an interested prospect. Here the
  // asymmetry reverses: a false "opened" sends t3's "we know you looked" to
  // someone who never saw the first email — a claim they can tell is false.
  assert.equal(isGenuineOpen({ openedAt: at(60 * 60_000) }), false);
  assert.equal(isGenuineOpen({}), false);
});

test("a negative delay is clock skew, and does not earn the label", () => {
  assert.equal(isGenuineOpen({ deliveredAt: DELIVERED, openedAt: at(-5_000) }), false);
});

// ---- openStateOf: three values, and why the third one exists ----

test("no feedback at all is `unknown`, never `not_opened`", () => {
  // THE case this file exists for. email_events is fed only by the Resend
  // webhook, so it is empty for a dropped event or a transport without one.
  // Collapsing this into `not_opened` would silently delete t3 from the funnel
  // for those shops, and nothing anywhere would report it.
  assert.equal(openStateOf({}), "unknown");
  assert.equal(openStateOf({ openCount: 0 }), "unknown");
});

test("delivered but never opened is `not_opened` — silence we can trust", () => {
  assert.equal(openStateOf({ deliveredAt: DELIVERED }), "not_opened");
});

test("a bounce is feedback too: the provider is reporting, they just never read it", () => {
  assert.equal(openStateOf({ bouncedAt: at(1_000) }), "not_opened");
});

test("a genuine open is `opened`; a prefetch one is not", () => {
  assert.equal(openStateOf({ deliveredAt: DELIVERED, openedAt: at(10 * 60_000) }), "opened");
  assert.equal(openStateOf({ deliveredAt: DELIVERED, openedAt: at(1_000) }), "not_opened");
});

// ---- openStateOfRun: several messages can disagree ----

test("one genuine open anywhere in the run wins", () => {
  const state = openStateOfRun([
    { deliveredAt: DELIVERED },                                    // ignored t1
    { deliveredAt: DELIVERED, openedAt: at(10 * 60_000) },         // opened t2
  ]);
  assert.equal(state, "opened");
});

test("an opened message followed by a dropped webhook stays `opened`", () => {
  // Taking the LAST message's state instead would fall back to `unknown` here,
  // and the shop would receive both follow-ups.
  assert.equal(openStateOfRun([{ deliveredAt: DELIVERED, openedAt: at(10 * 60_000) }, {}]), "opened");
});

test("an empty run is `unknown`, not `not_opened`", () => {
  assert.equal(openStateOfRun([]), "unknown");
  assert.equal(openStateOfRun([{}, {}]), "unknown");
});

// ---- gateAllows: the table the whole funnel turns on ----

test("`unknown` satisfies BOTH gates — no-feedback degrades to the whole funnel", () => {
  // The no-regression guarantee. Before open-gating every shop got t1, t2 and
  // t3; with no provider feedback it must still get all three, rather than
  // quietly becoming a one-email funnel.
  assert.equal(gateAllows("not-opened", "unknown"), true);
  assert.equal(gateAllows("opened", "unknown"), true);
});

test("an opener skips t2 and takes t3", () => {
  assert.equal(gateAllows("not-opened", "opened"), false);
  assert.equal(gateAllows("opened", "opened"), true);
});

test("a non-opener takes t2 and skips t3", () => {
  assert.equal(gateAllows("not-opened", "not_opened"), true);
  assert.equal(gateAllows("opened", "not_opened"), false);
});

test("an ungated step is never blocked", () => {
  for (const s of ["opened", "not_opened", "unknown"]) {
    assert.equal(gateAllows(undefined, s), true);
  }
});

test("every state passes exactly one of the two gates, or both when unknown", () => {
  // t2 and t3 are alternatives: a shop with real feedback must qualify for
  // exactly one of them, or the funnel either double-sends or goes silent.
  for (const s of ["opened", "not_opened"]) {
    const passes = [gateAllows("not-opened", s), gateAllows("opened", s)].filter(Boolean).length;
    assert.equal(passes, 1, `${s} passed ${passes} gates`);
  }
  assert.equal([gateAllows("not-opened", "unknown"), gateAllows("opened", "unknown")].filter(Boolean).length, 2);
});
