import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createServerClient } from "@/lib/supabase";
import { ensureFloristUser } from "@/lib/floristLink";
import { isSafeDest } from "@/lib/floristMagicLink";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isAllowed } from "@/lib/allowlist";
import { currentFloristLocale } from "@/lib/floristAuth";
import { resolveViewAs } from "@/lib/viewAs";
import { unreadTotal } from "@/lib/floristMessages";
import { LocaleProvider } from "@/components/florist/LocaleProvider";
import FloristShell from "@/components/florist/FloristShell";
import NoFloristAccount from "@/components/florist/NoFloristAccount";
import ViewAsBanner from "@/components/florist/ViewAsBanner";
import { ViewAsProvider } from "@/components/florist/ViewAsContext";
import AutoRefresh from "@/components/AutoRefresh";
import PostHogIdentify from "@/components/PostHogIdentify";

export const dynamic = "force-dynamic";
export const metadata = { manifest: "/manifest.webmanifest" };
// Lock zoom so the PWA feels native (no pinch-to-zoom / double-tap zoom).
export const viewport = { themeColor: "#1F7A55", maximumScale: 1, userScalable: false };

export default async function FloristLayout({ children }: { children: React.ReactNode }) {
  // Staff "view as florist" — render the florist app exactly as the chosen
  // florist sees it, READ-ONLY (resolveViewAs re-verifies the staff session;
  // florist write routes still 401 because currentFlorist() is null for staff).
  // Short-circuits the normal florist-session flow entirely.
  const va = await resolveViewAs();
  if (va) {
    const admin = createServiceClient();
    const [{ data: florist }, { count: openOffersCount }, { data: assignmentIdRows }] = await Promise.all([
      admin.from("florists").select("name").eq("id", va.floristId).maybeSingle(),
      admin
        .from("order_assignments")
        .select("id", { count: "exact", head: true })
        .eq("florist_id", va.floristId)
        .in("status", ["candidate", "queued", "sent", "opened"]),
      admin.from("order_assignments").select("id").eq("florist_id", va.floristId),
    ]);
    const assignmentIds = (assignmentIdRows ?? []).map((r) => r.id as string);
    // BOTH sources, or the badge disagrees with the list it points at — a "1"
    // over a page showing nothing is worse than no badge. A florist with no
    // orders yet has no assignments, and that is exactly who has a welcome
    // message waiting, so the issue count alone would always read 0 for them.
    let issueUnread = 0;
    if (assignmentIds.length) {
      const { count } = await admin
        .from("order_issues")
        .select("id", { count: "exact", head: true })
        .eq("florist_unread", true)
        .in("assignment_id", assignmentIds);
      issueUnread = count ?? 0;
    }
    const { count: messageUnread } = await admin
      .from("florist_messages")
      .select("id", { count: "exact", head: true })
      .eq("florist_id", va.floristId)
      .eq("florist_unread", true);
    const unreadMessagesCount = unreadTotal(issueUnread, messageUnread);
    const locale = await currentFloristLocale(); // view-as aware
    return (
      <div className="ds">
        <LocaleProvider locale={locale}>
          <ViewAsProvider>
            <FloristShell openOffersCount={openOffersCount ?? 0} unreadMessagesCount={unreadMessagesCount}>
              {children}
            </FloristShell>
          </ViewAsProvider>
        </LocaleProvider>
        <ViewAsBanner shopName={florist?.name ?? "florist"} />
        {/* Keep the support view live too — new offers/messages land without a reload. */}
        <AutoRefresh />
      </div>
    );
  }

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    // Carry the requested path through sign-in. Without this, a florist who
    // followed an order link from an email (or whose magic link had gone
    // stale) signed in and landed on the home screen, having lost the order
    // they came for. `x-pathname` is set by middleware.ts — a Server Component
    // can't read the pathname otherwise.
    const path = (await headers()).get("x-pathname");
    const next = isSafeDest(path) ? path! : "/florist";
    redirect(`/florist/login?next=${encodeURIComponent(next)}`);
  }

  let map: { florist_id: string } | null = null;
  const { data: mapping } = await supabase.from("florist_users").select("florist_id").eq("user_id", user.id).maybeSingle();
  map = mapping ?? null;
  if (!map && user.email) {
    // Shared with the magic-link redeem route (app/florist/m/[token]) so the
    // two sign-in paths can't drift on how an auth user gets attached.
    const floristId = await ensureFloristUser(createServiceClient(), user.id, user.email);
    if (floristId) map = { florist_id: floristId };
  }
  if (!map) {
    // Staff opening the florist PWA in another tab is the common trigger —
    // give them a way back instead of a dead end (was: no nav, no sign-out).
    const staff = await isAllowed(user.email);
    return <NoFloristAccount email={user.email ?? ""} isStaff={staff} />;
  }
  const locale = await currentFloristLocale();
  // "Open offer" = awaiting the florist's response (not yet accepted/declined/expired).
  // Cheap head-count query; RLS already scopes order_assignments to this florist.
  const { count: openOffersCount } = await supabase
    .from("order_assignments")
    .select("id", { count: "exact", head: true })
    .in("status", ["candidate", "queued", "sent", "opened"]);
  // Unread across BOTH sources the Messages tab shows, or the badge disagrees
  // with the list it points at. RLS scopes each to this florist.
  const [{ count: issueUnread }, { count: messageUnread }] = await Promise.all([
    supabase.from("order_issues").select("id", { count: "exact", head: true }).eq("florist_unread", true),
    supabase.from("florist_messages").select("id", { count: "exact", head: true }).eq("florist_unread", true),
  ]);
  const unreadMessagesCount = unreadTotal(issueUnread, messageUnread);
  return (
    <div className="ds">
      {/* Register the PWA service worker on the client (layout is a server component). */}
      <script dangerouslySetInnerHTML={{ __html: "if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}" }} />
      {/* Past the !map guard, so this florist is mapped to a real florists.id. */}
      <PostHogIdentify distinctId={user.id} email={user.email ?? ""} surface="florist" floristId={map.florist_id} />
      <LocaleProvider locale={locale}>
        <FloristShell openOffersCount={openOffersCount ?? 0} unreadMessagesCount={unreadMessagesCount ?? 0}>{children}</FloristShell>
      </LocaleProvider>
      {/* Live app: new offers/messages appear without a manual reload. */}
      <AutoRefresh />
    </div>
  );
}
