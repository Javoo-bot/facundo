import { cache } from "react";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { floristReadContext } from "@/lib/floristView";
import { isSinglePayment } from "@/lib/payoutMath";

/**
 * "Is the florist reading this page paid in one go, on accept?"
 *
 * The one place any florist-facing SCREEN asks that question. Order-specific
 * surfaces don't use this — the offer page already resolves the tier to compute
 * real figures (app/florist/(app)/orders/[id]/page.tsx) and passes the flag
 * down. This exists for the pages that carry the payment story with no order in
 * front of them: the help centre, the walkthrough, the welcome message.
 *
 * WHY it reads the tier ROW rather than comparing `trust_tier` to '6': the
 * split is data, and copy that reads the same data as the payout engine cannot
 * drift from it. Renumber the tiers again (we already did once, Z/Y/X/K → 1-4)
 * and this keeps working.
 *
 * Fails toward the SPLIT wording on every unhappy path — no session, no tier
 * assigned, an unreadable row. That asymmetry is deliberate: showing the 70/30
 * story to a paid-in-full shop understates what they are getting and is corrected the
 * moment they open a real offer, whereas showing "paid in full" to a tier-2
 * shop is a promise we would then break at the till.
 *
 * `cache()`d per request, so several sections of one page cost one query.
 */
export const floristSinglePayment = cache(async (): Promise<boolean> => {
  try {
    const ctx = await floristReadContext();
    if (!ctx) return false;
    // `florists` is staff-scoped under RLS, so the tier is read with the service
    // client keyed on this session's own florist id (the same pattern the
    // balance page uses). Nothing but the split percentage is read.
    const admin = createServiceClient();
    const { data: fl } = await admin
      .from("florists")
      .select("trust_tier")
      .eq("id", ctx.floristId)
      .maybeSingle();
    if (!fl?.trust_tier) return false;
    const { data: tier } = await admin
      .from("trust_tiers")
      .select("split_on_delivery")
      .eq("code", fl.trust_tier)
      .maybeSingle();
    return tier ? isSinglePayment(tier) : false;
  } catch {
    return false; // copy must never be the reason a page 500s
  }
});

/**
 * Swap a catalog key for its `*Full` sibling, but only for keys that have one.
 *
 * The guard rail is the point. `t()` returns a MISSING key as its own text, so
 * a blanket `${key}Full` remap does not fail loudly — it silently renders
 * "ui.guide.stepsTitle" into the page. Callers therefore pass the explicit set
 * of keys they have written and translated a variant for, and everything else
 * falls through untouched.
 */
export function fullVariant(key: string, variants: ReadonlySet<string>): string {
  return variants.has(key) ? `${key}Full` : key;
}
