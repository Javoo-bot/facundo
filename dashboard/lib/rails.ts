import type { PayoutRail } from "./payoutMath";
import { issueSingleUseCard } from "./airwallex/cards";
import { liveRailBlockReason, allowDemoLive } from "./railGate.ts";

export const CardRail: PayoutRail = { issue: (amt, cur, ref) => issueSingleUseCard(amt, cur, ref) };
// Records intent only — used until payments_live is flipped on. Never charges.
export const LedgerRail: PayoutRail = { issue: async (_a, _c, ref) => ({ ok: true, providerRef: `ledger:${ref}` }) };

// The demo-base guard and its AIRWALLEX_ALLOW_DEMO_LIVE opt-out live in
// railGate.ts (testable there; see its header). Re-exported so existing callers
// and `import { liveRailBlockReason } from "./rails"` keep working.
export { liveRailBlockReason, allowDemoLive };

export function getRail(paymentsLive: boolean): PayoutRail {
  // Pure decision in lib/railGate.ts (unit-tested). Live against the demo
  // Airwallex host refuses unless the deployment sets AIRWALLEX_ALLOW_DEMO_LIVE=1
  // — a staging-only escape hatch for rehearsing sandbox cards.
  const block = liveRailBlockReason(paymentsLive);
  if (block) {
    throw new Error(
      `payments_live cannot use demo Airwallex base (${process.env.AIRWALLEX_BASE || "default demo"}) — ` +
        `set AIRWALLEX_ALLOW_DEMO_LIVE=1 to issue real SANDBOX cards on purpose, ` +
        `or point AIRWALLEX_BASE at the production host.`,
    );
  }
  return paymentsLive ? CardRail : LedgerRail;
}
