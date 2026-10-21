import { notFound } from "next/navigation";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { LOCALES } from "@/lib/i18n";
import { flowBySlug } from "@/lib/flows/catalog";
import FlowEditor from "@/components/flows/FlowEditor";

export const dynamic = "force-dynamic";

// One funnel, end to end: every step, in order, with its wait time, its
// subject line and its body copy editable in place — plus, on the assignment
// funnel, the response-window ladder and the cut-off offset that decide how
// long each step actually lasts.
//
// Ops as well as admin, unlike /messages. The people who run the funnels are
// the people who should be able to change a subject line at 9am on a Saturday,
// and every write this page makes is either a draft (copy, published
// explicitly) or a bounded number (a wait, a window) — not a schema change and
// not a send.
export default async function FlowPage({ params }: { params: Promise<{ funnel: string }> }) {
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

  // After the gate, not before: which funnels exist is not something a signed
  // -out visitor should be able to enumerate from a 404 vs. a sign-in screen.
  const { funnel } = await params;
  const flow = flowBySlug(funnel);
  if (!flow) notFound();

  return (
    <main className="ds page" style={{ padding: "20px 24px 48px" }}>
      <FlowEditor flowId={flow.id} locales={[...LOCALES]} />
    </main>
  );
}
