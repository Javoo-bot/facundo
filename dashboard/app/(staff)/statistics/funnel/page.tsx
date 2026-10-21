import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import VisualFunnelClient from "@/components/statistics/VisualFunnelClient";
import { getStatsActiveDays, getVisualFunnelStats } from "@/lib/opsStats";
import { parseStatsRange } from "@/lib/statsRange";

export const dynamic = "force-dynamic";

/**
 * `/statistics/funnel` — the recruiting funnel drawn as a funnel.
 *
 * A sibling route rather than a tab inside /statistics, so the two views are
 * separately linkable and neither pays for the other's queries: General runs
 * eight section queries this page needs none of, and this page's cohort query
 * walks tables General never touches.
 *
 * Same auth gate, same range parsing and the same failure contract as its
 * sibling: the query gets its own catch and degrades to `null`, which the
 * client renders as "unavailable" rather than as a funnel of zeroes.
 */
export default async function VisualFunnelPage({
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

  // The two are independent: the funnel can be unavailable while the picker
  // still knows which days exist, and vice versa. Each degrades to `null` on
  // its own — for the day list that means "offer every past day" rather than
  // "offer none" (lib/opsStats.ts::getStatsActiveDays says why).
  const [funnel, activeDays] = await Promise.all([
    getVisualFunnelStats(supabase, range).catch((err: unknown) => {
      console.error("/statistics/funnel: unavailable —", err instanceof Error ? err.message : err);
      return null;
    }),
    getStatsActiveDays(supabase).catch((err: unknown) => {
      console.error("/statistics/funnel: active days unavailable —", err instanceof Error ? err.message : err);
      return null;
    }),
  ]);

  return <VisualFunnelClient range={range} data={funnel} activeDays={activeDays} />;
}
