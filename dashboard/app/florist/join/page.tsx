import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { canRedeemInvite } from "@/lib/floristInvite";

export const dynamic = "force-dynamic";

function ErrorCard({ title, body }: { title: string; body: string }) {
  return (
    <main className="ds page fc-readable" style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
      <div className="card" style={{ maxWidth: 420, padding: "28px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.2rem" }}>{title}</h1>
        <p style={{ color: "var(--ink-soft)", fontSize: ".9rem" }}>{body}</p>
      </div>
    </main>
  );
}

export default async function FloristJoinPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const { invite: token } = await searchParams;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(token ? `/florist/login?invite=${token}` : "/florist/login");
  if (!token) redirect("/florist");

  const admin = createServiceClient();
  const { data: invite } = await admin
    .from("florist_invites").select("id, florist_id, email, expires_at, accepted_at").eq("token", token).maybeSingle();

  if (!invite) {
    return <ErrorCard title="Invite not found" body="This invite link doesn't exist. Ask whoever invited you to send a new one." />;
  }
  const decision = canRedeemInvite(invite, user.email ?? "", new Date());
  if (!decision.ok) {
    const body = decision.reason === "expired" ? "This invite has expired. Ask whoever invited you to send a new one."
      : decision.reason === "accepted" ? "This invite has already been used."
      : "This invite was sent to a different email address. Sign out and sign in with the invited address.";
    return <ErrorCard title="Invite no longer valid" body={body} />;
  }

  const { error: insertError } = await admin
    .from("florist_users").insert({ user_id: user.id, florist_id: invite.florist_id, role: "member", email: user.email });
  if (insertError) {
    return <ErrorCard title="Already linked" body="You're already linked to a florist account: each person can only belong to one." />;
  }
  await admin.from("florist_invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);
  redirect("/florist");
}
