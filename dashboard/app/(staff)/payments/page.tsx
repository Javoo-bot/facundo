import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import PaymentsLedger, { type PayoutRow } from "@/components/payments/PaymentsLedger";
import { airwallexCardUrl, airwallexCardTransactionsUrl } from "@/lib/airwallex/links";
import { assessLiveCheckEligibility, needsLiveCheck } from "@/lib/airwallex/liveCheckEligibility";

// A "real" card provider_ref is an Airwallex card_id — the LedgerRail writes
// "ledger:<ref>" sentinels that don't link anywhere.
function cardDeepLink(rail: string | null, providerRef: string | null): string | null {
  if (rail !== "card" || !providerRef || providerRef.startsWith("ledger:")) return null;
  return airwallexCardUrl(providerRef);
}

export const dynamic = "force-dynamic";

// app/(staff)/layout.tsx enforces the auth + allow-list gate on first load,
// but Next.js doesn't re-run a layout on client-side (soft) navigation back
// to this route, so this inline gate — same pattern as every other staff
// page (e.g. app/(staff)/orders/page.tsx) — re-checks before rendering.
export default async function PaymentsPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "finance" && role !== "admin") {
    return <Forbidden reason="Payments is only available to Finance and Admin roles." />;
  }

  // Nested embed pulls the order + florist for each payout in one round trip.
  // This resolves cleanly (no PostgREST ambiguity) because each FK hop is
  // singular per supabase/migrations/2026-07-13-phase0-orders.sql:
  //   payouts.assignment_id -> order_assignments.id     (one FK)
  //   order_assignments.order_id -> orders.id           (one FK)
  //   order_assignments.florist_id -> florists.id       (one FK)
  // RLS-safe — session client, `authenticated` read policy on all four tables.
  const { data: payouts, error } = await supabase
    .from("payouts")
    .select(
      "id, leg, amount, currency, status, rail, provider_ref, created_at, card_status, dispute_status, last_txn_id, florist_id, order_assignments(order_id, orders(order_name), florists(name, is_test_shop))"
    )
    .order("created_at", { ascending: false });

  // Manual-leg rows have no order_assignments embed (there's no assignment),
  // so their florist name has to be resolved separately from florist_id — one
  // batch lookup rather than N+1s.
  const manualFloristIds = [...new Set((payouts ?? []).filter((p) => p.leg === "manual" && p.florist_id).map((p) => p.florist_id as string))];
  const { data: manualFlorists } = manualFloristIds.length
    ? await supabase.from("florists").select("id, name, is_test_shop").in("id", manualFloristIds)
    : { data: [] as { id: string; name: string; is_test_shop: boolean | null }[] };
  const manualFloristName = new Map((manualFlorists ?? []).map((f) => [f.id as string, f.name as string]));
  const manualFloristIsTest = new Map((manualFlorists ?? []).map((f) => [f.id as string, f.is_test_shop === true]));

  // The florist picker for the admin-only "Issue a card" form is NOT fetched
  // here any more. It was the full roster — paged in 1000-row batches so that
  // "full" really meant full — pulled on every /payments render for a form that
  // only opens when an admin clicks "Issue a card". PaymentsLedger now loads it
  // from /api/florists/options at that moment instead.

  // Compute the Airwallex console deep-link server-side — airwallexUrl reads
  // server-only env (AIRWALLEX_APP_BASE) that a client component can't see.
  const rows = (payouts ?? []).map((p) => {
    const assignmentEmbed = p.order_assignments as unknown as { florists?: { is_test_shop?: boolean | null } | null } | { florists?: { is_test_shop?: boolean | null } | null }[] | null;
    const embeddedFlorist = Array.isArray(assignmentEmbed)
      ? assignmentEmbed[0]?.florists
      : assignmentEmbed?.florists;
    const isTestShop = p.leg === "manual" && p.florist_id
      ? manualFloristIsTest.get(p.florist_id) === true
      : embeddedFlorist?.is_test_shop === true;
    return {
    ...p,
    manual_florist_name: p.leg === "manual" && p.florist_id ? manualFloristName.get(p.florist_id) ?? null : null,
    airwallex_url: cardDeepLink(p.rail ?? null, p.provider_ref ?? null),
    // Issuing has no per-transaction console URL — a disputed row links to the
    // card-transactions list where the dispute is surfaced.
    airwallex_txn_url: p.dispute_status ? airwallexCardTransactionsUrl() : null,
    // Batch 1 of the payments-visibility audit: same eligibility gate the
    // single-payout /live route uses, plus the "Airwallex has told us
    // nothing since issue" flag, so the list can point staff at the payouts
    // most likely to have stale stored card state — read-only, no Airwallex
    // calls at render time.
    live_check_eligible: assessLiveCheckEligibility({ rail: p.rail ?? null, provider_ref: p.provider_ref ?? null, status: p.status ?? null, is_test_shop: isTestShop }).eligible,
    needs_live_check: needsLiveCheck({ rail: p.rail ?? null, provider_ref: p.provider_ref ?? null, status: p.status ?? null, is_test_shop: isTestShop, card_status: p.card_status ?? null }),
  };
  }) as unknown as PayoutRow[];

  return <PaymentsLedger payouts={rows} error={error?.message ?? null} canIssueCard={role === "admin"} />;
}
