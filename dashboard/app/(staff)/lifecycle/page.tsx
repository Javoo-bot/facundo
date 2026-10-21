import { createServerClient } from "@/lib/supabase";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import OrderLifecycleClient from "@/components/lifecycle/OrderLifecycleClient";
import { BRAND, BRAND_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Order lifecycle · ${BRAND_NAME[BRAND]}`,
};

// A static reference/documentation surface: the Phase-0 order loop as a flow
// map (happy path + failure branches + build status). No data fetch beyond
// the auth/role check — the content is entirely client-rendered from
// dashboard/lib/lifecycle.ts.
export default async function LifecyclePage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  if (!allowed) {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "ops" && role !== "admin") {
    return <Forbidden reason="Order lifecycle is only available to Ops and Admin roles." />;
  }
  return <OrderLifecycleClient />;
}
