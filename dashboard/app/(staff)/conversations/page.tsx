import SignInScreen from "@/components/SignInScreen";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import ConversationsClient, { type ConversationRow } from "@/components/conversations/ConversationsClient";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

// app/(staff)/layout.tsx gates on first load, but a soft navigation doesn't
// re-run a layout — so this re-checks inline, same as every other staff page.
export default async function ConversationsPage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }

  // Read under RLS with the user's JWT (the allow-listed read policy on both
  // tables), not the service role — nothing here needs to bypass it.
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, channel, kind, order_id, status, escalation_reason, cx_unread, auto_turns, last_inbound_at, created_at, florists(name, email), orders(order_name), conversation_messages(id, direction, body_text, status, ai_generated, ai_confidence, ai_intent, actor, created_at)"
    )
    // Threads waiting on a person first, then most recent.
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(PAGE_SIZE);

  const rows = ((data ?? []) as unknown as ConversationRow[]).sort((a, b) => {
    const aw = a.status === "awaiting_human" ? 0 : 1;
    const bw = b.status === "awaiting_human" ? 0 : 1;
    return aw - bw;
  });

  return <ConversationsClient initialRows={rows} error={error?.message ?? null} />;
}
