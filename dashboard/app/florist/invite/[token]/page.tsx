import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export default async function InviteLandingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createServiceClient();
  const { data: invite } = await admin
    .from("florist_invites").select("accepted_at, expires_at").eq("token", token).maybeSingle();

  if (!invite) {
    return (
      <main className="ds page fc-readable" style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
        <div className="card" style={{ maxWidth: 420, padding: "28px 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.2rem" }}>Invite not found</h1>
          <p style={{ color: "var(--ink-soft)", fontSize: ".9rem" }}>
            This invite link doesn&apos;t exist. Ask whoever invited you to send a new one.
          </p>
        </div>
      </main>
    );
  }
  if (invite.accepted_at || new Date(invite.expires_at).getTime() < Date.now()) {
    return (
      <main className="ds page fc-readable" style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
        <div className="card" style={{ maxWidth: 420, padding: "28px 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.2rem" }}>Invite no longer valid</h1>
          <p style={{ color: "var(--ink-soft)", fontSize: ".9rem" }}>
            {invite.accepted_at ? "This invite has already been used." : "This invite has expired."}{" "}
            Ask whoever invited you to send a new one.
          </p>
        </div>
      </main>
    );
  }
  redirect(`/florist/login?invite=${token}`);
}
