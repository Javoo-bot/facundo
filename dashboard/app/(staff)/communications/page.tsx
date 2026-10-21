import SignInScreen from "@/components/SignInScreen";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import CommunicationsClient from "@/components/communications/CommunicationsClient";
import type { CommunicationRow } from "@/components/communications/types";

export const dynamic = "force-dynamic";

// "Reasonable page size (e.g. 200) with a load more" per
// docs/superpowers/specs/2026-07-24-communications-hub-design.md — the
// client component fetches further pages via the RLS-scoped browser client
// (same idiom as components/shell/GlobalSearch.tsx) once this first page is
// exhausted.
const PAGE_SIZE = 200;

// app/(staff)/layout.tsx enforces the auth + allow-list gate on first load,
// but a client-side (soft) navigation back to this route doesn't re-run a
// layout, so this inline gate — same pattern as every other staff page
// (e.g. app/(staff)/payments/page.tsx) — re-checks before rendering.
export default async function CommunicationsPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }

  // Nested embed pulls the order name for the Order column in one round
  // trip — resolves cleanly (no PostgREST ambiguity) since
  // communications.order_id -> orders.id is a single FK.
  const { data: rows, error } = await supabase
    .from("communications")
    .select("*, orders(order_name)")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  return <CommunicationsClient initialRows={(rows ?? []) as unknown as CommunicationRow[]} error={error?.message ?? null} />;
}
