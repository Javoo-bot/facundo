import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import StatisticsClient from "@/components/statistics/StatisticsClient";
import { parseStatsRange } from "@/lib/statsRange";
import {
  getOrdersStats,
  getAcceptanceStats,
  getFulfilmentStats,
  getIssuesStats,
  getUsageStats,
  getLoginStats,
  getFunnelStats,
  getMessagingStats,
  getStatsActiveDays,
} from "@/lib/opsStats";

export const dynamic = "force-dynamic";

/** `/statistics` — the General view; the funnel is the sibling route
 * `/statistics/funnel`. The `?from`/`?to` params drive the whole page:
 * StatisticsClient's date-range control does a `router.replace` on change (the
 * same pattern OrdersClient uses for its filters), which re-runs this
 * force-dynamic server component with fresh searchParams. No client-side
 * stats-fetching API route, because every getXStats() call below already needs
 * an RLS-backed SupabaseClient, which only exists server-side. */
export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "ops" && role !== "admin") {
    return <Forbidden reason="Statistics is only available to Ops and Admin roles." />;
  }

  const range = parseStatsRange(await searchParams);

  // Each section's data comes from its own table(s); a failure in one (e.g.
  // login_events/email_events not existing yet on a fresh deploy before the
  // migrations are applied) must not blank the rest of the page. So each query
  // gets its own catch slot and degrades to `null`, which StatisticsClient
  // renders as <SectionUnavailable />.
  //
  // `null` here means "we don't know", never "zero" — getXStats() throws on any
  // RPC failure rather than returning zeroed stats, precisely so a real backend
  // failure can't be read off the page as a real business number. This is the
  // only place that decision gets softened, and it softens it to an explicit
  // "unavailable", not to data.
  const section = <T,>(p: Promise<T>, name: string): Promise<T | null> =>
    p.catch((err: unknown) => {
      // Logged here rather than inside opsStats.ts so there's exactly one place
      // a swallowed stats failure is recorded.
      console.error(`/statistics: ${name} section unavailable —`, err instanceof Error ? err.message : err);
      return null;
    });

  const [orders, acceptance, fulfilment, issues, usage, logins, messaging, funnel, activeDays] = await Promise.all([
    section(getOrdersStats(supabase, range), "orders"),
    section(getAcceptanceStats(supabase, range), "acceptance"),
    section(getFulfilmentStats(supabase, range), "fulfilment"),
    section(getIssuesStats(supabase, range), "issues"),
    section(getUsageStats(supabase, range), "usage"),
    section(getLoginStats(supabase, range), "logins"),
    section(getMessagingStats(supabase, range), "messaging"),
    section(getFunnelStats(supabase, range), "funnel"),
    // Not a section — it feeds the date picker, not a panel — but it takes the
    // same treatment: `null` on failure, which the picker reads as "offer every
    // past day" rather than locking the calendar.
    section(getStatsActiveDays(supabase), "active days"),
  ]);

  return (
    <StatisticsClient
      range={range}
      activeDays={activeDays}
      data={{ orders, acceptance, fulfilment, issues, usage, logins, messaging, funnel }}
    />
  );
}
