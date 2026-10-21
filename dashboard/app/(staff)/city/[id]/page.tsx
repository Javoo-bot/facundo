import Link from "next/link";
import DashboardClient from "@/components/DashboardClient";
import ErrorState from "@/components/ErrorState";
import SignInScreen from "@/components/SignInScreen";
import { IconMapPin } from "@/components/icons";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import type { AppSettings, City, Florist, Outreach } from "@/lib/types";

export default async function CityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
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
  // even hitting this route directly.
  //
  // Bug fix (current-code defect #6): the previous `.single()` + `?? []`-style
  // handling discarded the query `error`, so a Supabase outage rendered
  // identically to "bad id" (the not-found screen) instead of a distinct
  // fetch-error state. `.maybeSingle()` fixes the first half of that
  // conflation for free — it resolves to `{ data: null, error: null }` for a
  // genuinely missing/inaccessible row (not-found) and only ever sets `error`
  // on a real query failure (outage) — and the `cityError` check below
  // surfaces that failure distinctly instead of silently falling through to
  // "not found".
  const { data: city, error: cityError } = await supabase
    .from("cities")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (cityError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-2 px-4">
        <div className="w-full max-w-sm">
          <ErrorState
            title="Couldn't load this city"
            description="Something went wrong fetching data from Supabase. This is a fetch error, not a missing city."
          />
        </div>
      </div>
    );
  }

  if (!city) {
    // Bad/foreign id, or RLS hides it — show a friendly not-found state
    // rather than crashing.
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-2 px-4">
        <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8 text-center shadow-sm">
          <IconMapPin className="mx-auto h-12 w-12 text-ink-faint" />
          <h1 className="mt-3 text-lg font-semibold text-ink">City not found</h1>
          <p className="mt-1 text-sm text-ink-soft">
            This city doesn&apos;t exist, or you don&apos;t have access to it.
          </p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-md border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-ink-soft shadow-sm transition hover:bg-surface-2"
          >
            ← Overview
          </Link>
        </div>
      </div>
    );
  }

  const { data: florists, error: floristsError } = await supabase
    .from("florists")
    .select("*")
    .eq("city_id", id)
    .is("deleted_at", null)
    .is("excluded_at", null)
    .order("name", { ascending: true });

  if (floristsError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-2 px-4">
        <div className="w-full max-w-sm">
          <ErrorState
            title="Couldn't load florists"
            description={`Something went wrong fetching florists for ${city.city}, ${city.country}. This is a fetch error, not an empty city.`}
          />
        </div>
      </div>
    );
  }

  // Settings (test-mode config) + this city's outreach log — fetched
  // alongside the florists so DashboardClient can render "contacted" badges
  // and the review/send panel without a client round-trip. Neither table has
  // an insert/update RLS policy (service-role only), so this is a read-only,
  // allow-listed `authenticated` fetch same as `florists` above.
  const floristIds = (florists ?? []).map((f) => f.id);
  const [{ data: settings }, { data: outreach }] = await Promise.all([
    supabase.from("app_settings").select("*").eq("id", 1).single(),
    floristIds.length
      ? supabase
          .from("outreach")
          .select("*")
          .in("florist_id", floristIds)
          .order("sent_at", { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  return (
    <DashboardClient
      initialFlorists={(florists ?? []) as Florist[]}
      city={city as City}
      settings={(settings ?? null) as AppSettings | null}
      outreach={(outreach ?? []) as Outreach[]}
    />
  );
}
