import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import WaitTime from "@/components/flows/WaitTime";

export const dynamic = "force-dynamic";

// Every clock in the order flows, on its own page. Deliberately not a tab on
// a funnel's message screen: minutes have nothing to do with wording, and a
// response window sitting next to a subject line is what made that screen
// hard to read.
export default async function WaitTimePage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  if (!allowed) {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "admin" && role !== "ops") {
    return <Forbidden reason="Order flow management is available to Ops and Admins." />;
  }

  return (
    <main className="ds page" style={{ padding: "20px 24px 48px" }}>
      <WaitTime />
    </main>
  );
}
