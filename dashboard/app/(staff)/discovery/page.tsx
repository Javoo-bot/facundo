import PipelineHome from "@/components/PipelineHome";
import SignInScreen from "@/components/SignInScreen";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAll";
import type { City, PipelineFlorist } from "@/lib/types";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const user = await getSessionUser();

  if (!user) {
    return <SignInScreen error={error} />;
  }

  // Defensive re-check: the OAuth callback should already have signed out
  // anyone not on the allow list, so this should be unreachable — but the
  // brief calls for a server-side check here too before any florist data is
  // fetched, in case a session outlives an allow-list change.
  const { allowed } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }

  // RLS requires the `authenticated` role, which the anon key + user JWT
  // (via @supabase/ssr cookies) provides — signed-out requests get zero rows
  // even hitting this route directly. Overview + Hub aggregate across all
  // cities client-side (lib/stats.ts), so the roster has to arrive WHOLE:
  // paged via lib/fetchAll.ts because PostgREST silently caps a plain select
  // at 1000 rows, and there are ~3.4k florists — every per-city count and
  // supply-health number was computed off the alphabetical first third.
  const [
    { data: cities, error: citiesError },
    { rows: florists, error: floristsError },
  ] = await Promise.all([
    supabase.from("cities").select("*").order("city", { ascending: true }),
    // Narrowed to the columns this page actually consumes: the per-city
    // grouping (city_id), the pipeline phase counts (lifecycle_stage), the
    // engagement lists (id, name, email, rating), and the Supply-health
    // aggregates (phone_*, is_ecommerce, drafted_email — see
    // lib/stats.ts::aggregateFlorists). `select("*")` was ~1.8 KB a row, so
    // ~11.4 MB across the roster; these ten columns are a fraction of that.
    // Unlike home, this page genuinely needs the rows (it groups them per
    // city), so it narrows columns rather than switching to an aggregate view.
    fetchAllRows<PipelineFlorist>((from, to) =>
      supabase
        .from("florists")
        .select("id, name, city_id, email, rating, review_count, lifecycle_stage, phone_maps, phone_web, is_ecommerce, drafted_email")
        .is("deleted_at", null)
        .is("excluded_at", null)
        .order("name", { ascending: true })
        .order("id")
        .range(from, to)
    ),
  ]);

  // Bug fix: a failed query used to fall back to `?? []` silently, so a
  // Supabase outage rendered identically to "0 cities" (the EmptyState CTA,
  // not an error). Surface the fetch failure distinctly instead.
  const fetchError = citiesError ?? floristsError ?? null;

  return (
    <PipelineHome
      cities={(cities ?? []) as City[]}
      florists={florists}
      fetchError={fetchError != null}
    />
  );
}
