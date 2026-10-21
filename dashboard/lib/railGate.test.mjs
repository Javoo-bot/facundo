import test from "node:test";
import assert from "node:assert/strict";
import { allowDemoLive, liveRailBlockReason, testShopLiveAllowed } from "./railGate.ts";

const DEMO = "https://api-demo.airwallex.com";
const LIVE = "https://api.airwallex.com";

// Every case states the env explicitly rather than leaning on process.env, so
// these assertions can't be flipped by whatever the ambient shell happens to set.
const env = (base, flag) => ({ AIRWALLEX_BASE: base, AIRWALLEX_ALLOW_DEMO_LIVE: flag });

test("payments_live off: never blocked, whatever the base or flag", () => {
  for (const base of [DEMO, LIVE, undefined]) {
    for (const flag of [undefined, "1", "0"]) {
      assert.equal(liveRailBlockReason(false, env(base, flag)), null);
    }
  }
});

test("payments_live on + demo base + no flag: blocked (the pre-existing guard)", () => {
  assert.equal(liveRailBlockReason(true, env(DEMO, undefined)), "demo-airwallex-base");
});

test("payments_live on + demo base + flag exactly '1': allowed, so staging issues sandbox cards", () => {
  assert.equal(liveRailBlockReason(true, env(DEMO, "1")), null);
});

test("the flag fails CLOSED — only the exact string '1' opts in", () => {
  for (const flag of ["true", "yes", "TRUE", "on", "0", "", " ", " 1 ", "01", "1x", "2"]) {
    assert.equal(
      liveRailBlockReason(true, env(DEMO, flag)),
      "demo-airwallex-base",
      `AIRWALLEX_ALLOW_DEMO_LIVE=${JSON.stringify(flag)} must not opt in`,
    );
  }
});

// The safety property that matters most: this flag may only ever RELAX the
// demo-base case. On a production base it must be inert in both directions —
// it can neither block real issuance nor grant anything extra.
test("production base: the flag changes nothing", () => {
  assert.equal(liveRailBlockReason(true, env(LIVE, undefined)), null);
  assert.equal(liveRailBlockReason(true, env(LIVE, "1")), null);
  assert.equal(liveRailBlockReason(true, env(LIVE, "0")), null);
});

test("an unset base defaults to demo, so it is still blocked without the flag", () => {
  assert.equal(liveRailBlockReason(true, env(undefined, undefined)), "demo-airwallex-base");
  assert.equal(liveRailBlockReason(true, env(undefined, "1")), null);
});

test("allowDemoLive reads the flag directly and fails closed", () => {
  assert.equal(allowDemoLive({ AIRWALLEX_ALLOW_DEMO_LIVE: "1" }), true);
  for (const flag of [undefined, "", "true", "0", " 1 "]) {
    assert.equal(allowDemoLive({ AIRWALLEX_ALLOW_DEMO_LIVE: flag }), false);
  }
});

// testShopLiveAllowed: the one place a test-shop florist can get a real card —
// the Airwallex SANDBOX, opted in explicitly, and never for a /testing demo order.
test("testShopLiveAllowed: a /testing demo order is refused no matter what", () => {
  assert.equal(testShopLiveAllowed(true, env(DEMO, "1")), false);
  assert.equal(testShopLiveAllowed(true, env(LIVE, "1")), false);
  assert.equal(testShopLiveAllowed(true, env(DEMO, undefined)), false);
});

test("testShopLiveAllowed: an ordinary test-shop order needs BOTH the demo base and the flag", () => {
  assert.equal(testShopLiveAllowed(false, env(DEMO, "1")), true);
  assert.equal(testShopLiveAllowed(false, env(DEMO, undefined)), false);
  assert.equal(testShopLiveAllowed(false, env(LIVE, "1")), false, "never on a production base, even with the flag");
});

test("testShopLiveAllowed: an unset base defaults to demo, so the flag alone is enough", () => {
  assert.equal(testShopLiveAllowed(false, env(undefined, "1")), true);
  assert.equal(testShopLiveAllowed(false, env(undefined, undefined)), false);
});

test("falls back to process.env when no env object is passed", () => {
  const saved = { b: process.env.AIRWALLEX_BASE, f: process.env.AIRWALLEX_ALLOW_DEMO_LIVE };
  try {
    process.env.AIRWALLEX_BASE = DEMO;
    delete process.env.AIRWALLEX_ALLOW_DEMO_LIVE;
    assert.equal(liveRailBlockReason(true), "demo-airwallex-base");
    process.env.AIRWALLEX_ALLOW_DEMO_LIVE = "1";
    assert.equal(liveRailBlockReason(true), null);
  } finally {
    for (const [k, v] of [["AIRWALLEX_BASE", saved.b], ["AIRWALLEX_ALLOW_DEMO_LIVE", saved.f]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
