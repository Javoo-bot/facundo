import MessageEditor from "@/components/messages/MessageEditor";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { LOCALES } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// The message editor: pick a message, see it rendered as the recipient will,
// click a block to edit it, publish when the whole change is ready.
//
// Admin-gated exactly as /email-templates is — this decides what real florists
// and customers receive. The same request-cached getSessionUser/getStaffAccess
// checks every (staff) page repeats (defence in depth against a session
// outliving an allow-list edit).
export default async function MessagesPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  if (!allowed) {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "admin") return <Forbidden reason="The message editor is only available to Admins." />;

  return (
    <main className="ds page" style={{ padding: "20px 24px 48px" }}>
      <header style={{ marginBottom: 16 }}>
        <p className="eyebrow">Outgoing communications</p>
        <h1 style={{ margin: "4px 0 0", fontSize: "1.35rem" }}>Messages</h1>
        <p style={{ margin: "6px 0 0", fontSize: ".86rem", color: "var(--ink-soft)", maxWidth: "52em" }}>
          Everything we send, rendered exactly as the recipient sees it. Edits are saved as drafts and change
          nothing until you publish.
        </p>
      </header>
      <MessageEditor locales={[...LOCALES]} />
    </main>
  );
}
