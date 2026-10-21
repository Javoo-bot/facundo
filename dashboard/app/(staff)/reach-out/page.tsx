import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import ReachOutClient from "@/components/reachout/ReachOutClient";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import type { ReachOutSignals } from "@/lib/reachout/ranking";

export const dynamic = "force-dynamic";

/** The campaign's country. A constant rather than a query param: there is one
 * campaign, and a country picker would imply the funnel is scoped per-country
 * when the scoping actually lives in `app_settings.sequence_auto_enrol_countries`.
 * When a second market opens, this and that setting move together. */
const CAMPAIGN_COUNTRY = "ES";

/** Ceiling on shops fetched for the call list. Comfortably above Spain's ~1,950
 * so nothing is lost today, and bounded so one enormous market cannot turn this
 * page into a multi-megabyte render. The RPC orders by signal, so if a market
 * ever exceeds this the rows dropped are the ones with no engagement. */
const MAX_SHOPS = 10000;

/**
 * `/reach-out` — the recruiting call list.
 *
 * Sequences answers "what is the funnel doing"; this answers "who do I phone
 * next", which is a different job for a different person. Ops/admin only, like
 * /statistics: it is a whole market's contact details on one screen.
 */
export default async function ReachOutPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;

  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "ops" && role !== "admin") {
    return <Forbidden reason="Reach Out is only available to Ops and Admin roles." />;
  }

  // RLS-safe: the RPC is `security definer` and re-checks is_email_allowed()
  // itself, so it is called on the SESSION client, not the service client.
  //
  // Its own catch, degrading to null: the client renders that as "unavailable"
  // rather than as an empty call list, which would read as "nobody to ring"
  // and is the one wrong answer this page can give.
  let rows: RawRow[] = [];
  let failed = false;
  try {
    // PostgREST caps a result at 1000 rows unless asked otherwise, and Spain
    // alone is already ~1,950 shops. Unraised, this page silently showed an
    // arbitrary ~1000 of them: "Florists that joined: 3" against a real 8, and
    // an empty ranking because the engaged shops fell outside the window. The
    // same cap lib/fetchAll.ts exists to page around elsewhere.
    //
    // The RPC also orders by signal, so even if a market ever outgrows this
    // ceiling the rows lost are the ones with nothing to show — never a joiner,
    // a clicker or an opener.
    const { data, error } = await supabase
      .rpc("get_reachout_signals", { p_country: CAMPAIGN_COUNTRY })
      .limit(MAX_SHOPS);
    if (error) throw error;
    rows = (data ?? []) as RawRow[];
  } catch (err: unknown) {
    console.error("/reach-out: signals unavailable —", err instanceof Error ? err.message : err);
    failed = true;
  }

  // Also read the send settings, so the page can say what the funnel is
  // currently allowed to do. A call list that looks busy while
  // `sequence_enabled` is false is actively misleading — nothing is being sent
  // to any of these shops.
  const { data: settings } = await supabase
    .from("app_settings")
    .select("sequence_enabled, sequence_daily_send_cap, sequence_min_gap_hours, sequence_auto_enrol_scraped, sequence_auto_enrol_countries")
    .eq("id", 1)
    .maybeSingle();

  return (
    <ReachOutClient
      shops={rows.map(toSignals)}
      failed={failed}
      country={CAMPAIGN_COUNTRY}
      settings={{
        sequenceEnabled: settings?.sequence_enabled ?? false,
        autoEnrolScraped: settings?.sequence_auto_enrol_scraped ?? false,
        autoEnrolCountries: (settings?.sequence_auto_enrol_countries as string[] | null) ?? null,
        dailySendCap: settings?.sequence_daily_send_cap ?? null,
        minGapHours: settings?.sequence_min_gap_hours ?? null,
      }}
    />
  );
}

/** The RPC's row shape — snake_case, and bigint counts arrive as strings
 * through PostgREST. */
interface RawRow {
  florist_id: string;
  name: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  rating: number | null;
  review_count: number | null;
  joined_at: string | null;
  engaged_at: string | null;
  opened_at: string | null;
  click_count: number | string | null;
  open_count: number | string | null;
  delivered_count: number | string | null;
  bounced_count: number | string | null;
  touches_sent: number | string | null;
  suppressed: boolean | null;
  enrolled: boolean | null;
  last_signal_at: string | null;
}

/** Postgres `bigint` comes back as a STRING through PostgREST. Left as-is it
 * would flow into the score's arithmetic as `"3"`, where `Math.max(0, "3")`
 * happens to work and `-w * "3"` happens to work, but `?? 0` on an empty
 * string does not — the sort would be subtly wrong rather than obviously
 * broken. Parse once, here, at the boundary. */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function toSignals(r: RawRow): ReachOutSignals {
  return {
    floristId: r.florist_id,
    name: r.name,
    city: r.city,
    email: r.email,
    phone: r.phone,
    rating: r.rating,
    reviewCount: num(r.review_count),
    joinedAt: r.joined_at,
    engagedAt: r.engaged_at,
    openedAt: r.opened_at,
    clickCount: num(r.click_count),
    openCount: num(r.open_count),
    deliveredCount: num(r.delivered_count),
    bouncedCount: num(r.bounced_count),
    touchesSent: num(r.touches_sent),
    suppressed: r.suppressed,
    enrolled: r.enrolled,
    lastSignalAt: r.last_signal_at,
  };
}
