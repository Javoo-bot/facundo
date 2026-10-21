// Whether a payout may use the REAL card rail — split out of lib/rails.ts so it
// can be tested. rails.ts reaches issueSingleUseCard → client.ts → an aliased
// "@/lib/externalOps" import, which plain `node --test` cannot resolve, so the
// decision itself lives here with no dependency beyond the pure link helpers.
//
// THE GUARD. Pointing at Airwallex's sandbox while app_settings.payments_live is
// on used to be refused outright: believing you are live while every card is
// fake is the more dangerous of the two mistakes, so it failed loudly.
//
// THE OPT-OUT. That left staging unable to exercise card issuance at all — it
// could only record ledger intent, so the issue → authorize → settle path went
// untested until production. AIRWALLEX_ALLOW_DEMO_LIVE=1 says "yes, I am
// deliberately pointed at the sandbox and I want real sandbox cards."
//
// The flag can only ever RELAX the demo-base case. Against a production base the
// block reason is already null, so setting it grants nothing and clearing it
// takes nothing away — it cannot make production more permissive. It is read
// per call (never cached) and fails closed on anything but the exact string "1",
// so a stray "true"/"yes"/"0" leaves the guard fully armed.
import { isDemoAirwallexBase } from "./airwallex/links.ts";

/** Only the fields consulted here — accepts process.env or a literal in tests. */
export interface RailGateEnv {
  AIRWALLEX_BASE?: string;
  AIRWALLEX_ALLOW_DEMO_LIVE?: string;
  // Index signature so process.env (ProcessEnv) assigns cleanly: without it TS
  // treats this all-optional shape as a "weak type" and rejects the default arg.
  [key: string]: string | undefined;
}

/** Exact-match "1" only. Any other value leaves the guard armed. */
export function allowDemoLive(env: RailGateEnv = process.env): boolean {
  return env.AIRWALLEX_ALLOW_DEMO_LIVE === "1";
}

/** Non-null = the live card rail is refused, with the reason. */
export function liveRailBlockReason(
  paymentsLive: boolean,
  env: RailGateEnv = process.env,
): "demo-airwallex-base" | null {
  // Not live → LedgerRail, which never talks to a provider. Nothing to block.
  if (!paymentsLive) return null;
  // Mirrors client.ts's own default: an unset base IS the demo host.
  if (!isDemoAirwallexBase(env.AIRWALLEX_BASE || "https://api-demo.airwallex.com")) return null;
  return allowDemoLive(env) ? null : "demo-airwallex-base";
}

// Whether a florist WE own (florists.is_test_shop) may get a REAL card. This is
// the one place that question can ever come back "yes" — see
// payoutMath.ts::effectivePaymentsLive, which otherwise forces every test-shop
// payout onto the ledger rail no matter what app_settings.payments_live says.
//
// A /testing admin demo-sandbox order (orders.is_demo=true) is excluded here,
// full stop — that surface's "can never receive a real card" guarantee stays
// absolute regardless of any flag (see CLAUDE.md's demo-sandbox safety
// properties). An ordinary test-shop order (e.g. a manual QA run through the
// mock-order tool) may get a real SANDBOX card, but only on the Airwallex
// demo base and only with the same explicit AIRWALLEX_ALLOW_DEMO_LIVE=1 opt-in
// that unblocks demo-base issuance in general — never on a production base.
export function testShopLiveAllowed(isDemoOrder: boolean, env: RailGateEnv = process.env): boolean {
  if (isDemoOrder) return false;
  return isDemoAirwallexBase(env.AIRWALLEX_BASE || "https://api-demo.airwallex.com") && allowDemoLive(env);
}
