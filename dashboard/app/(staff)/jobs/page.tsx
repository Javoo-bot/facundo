import JobsHistoryClient from "@/components/JobsHistoryClient";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import type { IngestJob } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const user = await getSessionUser();

  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "ops" && role !== "admin") {
    return <Forbidden reason="Jobs is only available to Ops and Admin roles." />;
  }

  // RLS-scoped read — same allow-listed `authenticated` role as app/page.tsx
  // and app/api/jobs. `ingest_jobs` has no insert/update policy; only the
  // service-role ingest CLI writes it.
  const { data } = await supabase
    .from("ingest_jobs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(50);

  return <JobsHistoryClient jobs={(data ?? []) as IngestJob[]} />;
}
