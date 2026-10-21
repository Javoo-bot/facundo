import { notFound } from "next/navigation";
import FloristCardClient, {
  type AssignmentRow,
  type PayoutRow,
} from "@/components/florist/FloristCardClient";
import SignInScreen from "@/components/SignInScreen";
import type { FloristStatsRow } from "@/components/florist/floristOps";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import type { AppSettings, City, Florist, FloristMeeting, FloristNote, Outreach } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function FloristPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const user = await getSessionUser();
  if (!user) return <SignInScreen error={error} />;
  const { allowed, role: staffRole } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  // Only ops/admin may open the read-only "view as florist" support session,
  // and only ops/admin may see the editable "Operational" section.
  const canViewAs = staffRole === "ops" || staffRole === "admin";
  const canSeeOperational = staffRole === "ops" || staffRole === "admin";
  const canIssueCard = staffRole === "admin";

  // Not filtering `excluded_at` here (unlike the pre-fulfillment version of
  // this page) — an excluded florist must still be viewable so staff can
  // restore them. `deleted_at` (hard/soft delete) still hides the row.
  const { data: florist, error: floristError } = await supabase
    .from("florists")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (floristError) {
    return (
      <div className="ds flex min-h-[50vh] items-center justify-center px-4">
        <p className="text-sm text-crit">Failed to load florist. Try again.</p>
      </div>
    );
  }
  if (!florist) notFound();

  const f = florist as Florist;

  const [
    { data: city },
    { data: settings },
    { data: outreach },
    { data: notes },
    { data: meetings },
    { data: assignments },
    { data: floristUser },
    { data: statsRow },
  ] = await Promise.all([
    supabase.from("cities").select("*").eq("id", f.city_id).maybeSingle(),
    supabase.from("app_settings").select("*").eq("id", 1).single(),
    supabase.from("outreach").select("*").eq("florist_id", id).order("sent_at", { ascending: false }),
    supabase.from("florist_notes").select("*").eq("florist_id", id).order("created_at", { ascending: false }),
    supabase
      .from("florist_meetings")
      .select("*")
      .eq("florist_id", id)
      .order("meeting_at", { ascending: false }),
    // Fulfillment: every assignment ever offered to this florist, with the
    // parent order's headline fields folded in — one round trip. Newest first.
    supabase
      .from("order_assignments")
      .select("*, orders(id, order_name, status, delivery_at, delivery_area)")
      .eq("florist_id", id)
      .order("assigned_at", { ascending: false }),
    // Activation gate (Sprint 3): a florist is loggable-in iff a florist_users
    // row exists for them — see lib/floristActivation.ts.
    supabase.from("florist_users").select("user_id").eq("florist_id", id).maybeSingle(),
    // Feedback loop (Sprint 4): all-time track record, see florist_stats view.
    supabase.from("florist_stats").select("*").eq("florist_id", id).maybeSingle(),
  ]);

  const assignmentRows = (assignments ?? []) as AssignmentRow[];
  const assignmentIds = assignmentRows.map((a) => a.id);
  // assignmentRows is already newest-first (assigned_at desc) — the first 10
  // ids are the "recent window" the tier-review hint looks at.
  const recentAssignmentIds = assignmentIds.slice(0, 10);

  // Payouts reach this florist two ways: an ORDER leg via assignment_id (hence
  // the sequencing after assignments resolve — mirrors
  // app/(staff)/orders/[id]/page.tsx), or a MANUAL ad-hoc leg via the direct
  // florist_id column (no assignment at all). Both are fetched, so a florist
  // with only manual payouts — or one who just got one issued from this very
  // page — still sees them. Built as a string so an empty assignmentIds doesn't
  // emit `in.()`, which PostgREST rejects.
  const payoutFilter = assignmentIds.length
    ? `assignment_id.in.(${assignmentIds.join(",")}),florist_id.eq.${f.id}`
    : `florist_id.eq.${f.id}`;
  const [{ data: payouts }, { data: recentIssues }] = await Promise.all([
    supabase
      .from("payouts")
      .select("*, order_assignments(order_id, orders(order_name))")
      .or(payoutFilter)
      .order("created_at", { ascending: false }),
    // Issue count within the recent window only, for the tier-review hint —
    // see floristOps.ts::tierReviewRecommended for why this isn't in the view.
    recentAssignmentIds.length
      ? supabase.from("delivery_events").select("id").in("assignment_id", recentAssignmentIds).eq("type", "problem")
      : Promise.resolve({ data: [] as { id: string }[] }),
  ]);

  return (
    <FloristCardClient
      florist={f}
      city={(city ?? null) as City | null}
      settings={(settings ?? null) as AppSettings | null}
      outreach={(outreach ?? []) as Outreach[]}
      notes={(notes ?? []) as FloristNote[]}
      meetings={(meetings ?? []) as FloristMeeting[]}
      assignments={assignmentRows}
      payouts={(payouts ?? []) as PayoutRow[]}
      hasLogin={!!floristUser}
      stats={(statsRow ?? null) as FloristStatsRow | null}
      recentIssueCount={(recentIssues ?? []).length}
      canViewAs={canViewAs}
      canSeeOperational={canSeeOperational}
      canIssueCard={canIssueCard}
      isAdmin={staffRole === "admin"}
    />
  );
}
