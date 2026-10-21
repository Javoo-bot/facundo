import ExternalOpsLog, { type ExternalOpRow } from "@/components/ExternalOpsLog";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const user = await getSessionUser();

  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "ops" && role !== "admin") {
    return <Forbidden reason="External ops is only available to Ops and Admin roles." />;
  }

  // RLS-scoped read — allow-listed `authenticated` role. external_ops has no
  // insert/update policy; only server code / the worker (service role) writes it.
  const { data } = await supabase
    .from("external_ops")
    .select("id, provider, operation, direction, order_id, ref, ok, skipped, status_code, duration_ms, error, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  return <ExternalOpsLog rows={(data ?? []) as ExternalOpRow[]} />;
}
