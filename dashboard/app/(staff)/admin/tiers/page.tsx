import { createServerClient } from "@/lib/supabase";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import TrustTiersClient from "@/components/admin/TrustTiersClient";
import type { TrustTier } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TiersPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) { await supabase.auth.signOut(); return <SignInScreen error="unauthorized" />; }
  if (role !== "ops" && role !== "admin") {
    return <Forbidden reason="Trust tiers is only available to Ops and Admin roles." />;
  }
  const { data } = await supabase.from("trust_tiers").select("*").order("code");
  return <TrustTiersClient tiers={(data ?? []) as TrustTier[]} />;
}
