import StaffShell from "@/components/shell/StaffShell";
import SignInScreen from "@/components/SignInScreen";
import PostHogIdentify from "@/components/PostHogIdentify";
import AutoRefresh from "@/components/AutoRefresh";
import { createServerClient } from "@/lib/supabase";
import { getSessionUser, getStaffAccess, getAttentionCached } from "@/lib/authCache";

export const dynamic = "force-dynamic";

/**
 * Shared layout for every staff-console route (this `(staff)` route group —
 * the parens don't affect URLs, see dashboard/app/(staff)/*). Auth/allow-list
 * gate is copied from the pre-redesign app/orders/page.tsx pattern rather than
 * factored into a helper, matching this codebase's existing convention of
 * each server entry point re-doing the same three checks inline (defense in
 * depth against a session outliving an allow-list edit — see lib/allowlist.ts).
 *
 * Auth + florist routes (app/auth/**, app/florist/**) live OUTSIDE this group
 * on purpose and must never get the staff shell.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  if (!user) {
    return <SignInScreen />;
  }

  const { allowed, role } = await getStaffAccess(user.email);
  if (!allowed) {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }

  const supabase = await createServerClient();

  // `app_settings` is a singleton row (id=1) — see lib/types.ts AppSettings.
  // `orders` has no insert/update RLS policy (service-role only), so this is
  // the same allow-listed `authenticated` read every other staff page does.
  //
  // The escalated-order head-count that used to run here as well is gone with
  // the Orders nav item it fed (see StaffShell's NAV_GROUPS): it was a
  // `count: exact` over `orders` on EVERY staff page render, and nothing
  // renders it any more. Restore both together if Orders comes back to the
  // sidebar.
  const [{ data: settings }, attentionRows] = await Promise.all([
    supabase.from("app_settings").select("test_mode, operator_view").eq("id", 1).maybeSingle(),
    getAttentionCached(),
  ]);
  const attentionCount = attentionRows.length;

  return (
    <StaffShell
      userEmail={user.email ?? ""}
      role={role}
      testMode={settings?.test_mode ?? true}
      attentionCount={attentionCount}
      operatorView={settings?.operator_view ?? false}
    >
      {/* Register the PWA service worker so staff can opt into CX alert push
          (Settings → "Enable CX alerts") — mirrors the florist app layout. */}
      <script dangerouslySetInnerHTML={{ __html: "if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}" }} />
      {/* Both gates above have passed, so this only ever identifies a real,
          allow-listed staff user. */}
      <PostHogIdentify distinctId={user.id} email={user.email ?? ""} surface="staff" />
      {/* Live console: re-runs each route's server fetch on an interval so
          order-loop changes (new orders, approvals, payout/status churn) land
          without a manual reload. Client state (open forms/filters) is kept. */}
      <AutoRefresh />
      {children}
    </StaffShell>
  );
}
