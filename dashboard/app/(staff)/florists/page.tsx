import SignInScreen from "@/components/SignInScreen";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAll";
import FloristsDirectory, { type FloristRow } from "@/components/florists/FloristsDirectory";

export const dynamic = "force-dynamic";

export default async function FloristsPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }

  // RLS-safe — session client, `authenticated` policy on both florists and
  // cities. Soft-deleted and permanently-excluded florists are filtered out
  // at the query level, mirroring every other florist-listing query in the
  // dashboard (app/(staff)/page.tsx, app/(staff)/city/[id]/page.tsx,
  // app/(staff)/discovery/page.tsx, app/florist/[id]/page.tsx) — `excluded_at`
  // means "permanently excluded, hidden + skipped by ingest" per schema.sql.
  //
  // Paged (see lib/fetchAll.ts): the roster is ~3.4k rows, so the old
  // unbounded select silently stopped at PostgREST's 1000-row cap. Ordered by
  // name, that cut fell around "Ex…" — and since the directory defaults to the
  // `production` stage filter, of which only one florist sorts that early, the
  // whole page rendered a single row. `.order("id")` is the unique tiebreak
  // paging needs; `name` is not unique. Column list is narrowed to what the
  // table renders (see FloristRow) — at 3.4k rows `select("*")` would be ~5.8 MB.
  // No explicit row generic: supabase-js types a to-one embed (`cities(...)`)
  // as an ARRAY, though PostgREST returns a single object for it at runtime —
  // so the row type is taken from the query and reconciled in the cast below.
  const { rows: florists, error } = await fetchAllRows((from, to) =>
    supabase
      .from("florists")
      .select("id, name, trust_tier, lifecycle_stage, phone_web, phone_maps, email, cities(city, country)")
      .is("deleted_at", null)
      .is("excluded_at", null)
      .order("name")
      .order("id")
      .range(from, to)
  );

  // Operational load + track record per florist. This used to fetch EVERY
  // order_assignments row and EVERY paid payout — both whole-table, both paged
  // in 1000-row batches — and reduce them in JS on every render, purely to
  // produce four numbers a florist. `florist_workload` does the same group-by
  // in Postgres and returns one row per florist:
  //   active_orders  = an accepted assignment currently being fulfilled
  //   pending_offers = a candidate/offer awaiting the florist
  //   history_count  = lifetime delivered/released
  //   paid_total     = lifetime paid-out amount (status 'paid')
  // The status buckets live in the view now — see
  // supabase/migrations/2026-08-11-order-working-set.sql; keep them in step
  // with anything that reclassifies an assignment status.
  //
  // Still paged: the view has one row per florist, so it hits PostgREST's
  // 1000-row cap exactly like the roster does.
  const { rows: workload } = await fetchAllRows<{
    florist_id: string;
    active_orders: number;
    pending_offers: number;
    history_count: number;
    paid_total: number | null;
    paid_currency: string | null;
  }>((from, to) => supabase.from("florist_workload").select("*").order("florist_id").range(from, to));

  const byFlorist = new Map(workload.map((w) => [w.florist_id, w]));

  const enriched = florists.map((f) => {
    const w = byFlorist.get(f.id);
    return {
      ...f,
      activeOrders: w?.active_orders ?? 0,
      pendingOffers: w?.pending_offers ?? 0,
      historyCount: w?.history_count ?? 0,
      // `sum()` comes back from PostgREST as a numeric string.
      paidTotal: w?.paid_total == null ? 0 : Number(w.paid_total),
      paidCurrency: w?.paid_currency ?? null,
    };
  });

  return (
    // `as unknown as` because of the embed-array mismatch noted on the query
    // above — `cities` is typed `{...}[]` but arrives as a single object.
    <FloristsDirectory florists={enriched as unknown as FloristRow[]} error={error?.message ?? null} />
  );
}
