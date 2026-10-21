import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { currentFlorist } from "@/lib/floristAuth";
import { floristReadContext } from "@/lib/floristView";
import FloristAccount from "@/components/florist/FloristAccount";

export const dynamic = "force-dynamic";

type InviteRow = { id: string; email: string; created_at: string; expires_at: string };

export default async function FloristAccountPage() {
  const ctx = await floristReadContext();
  if (!ctx) return null; // layout gates; defensive
  const admin = createServiceClient();

  // Displayed identity + role. In a staff view-as session we present the
  // florist's own contact email and the owner view (so support sees the full
  // team/invite picture). Otherwise the signed-in member's email + role.
  let email = "";
  let role: "owner" | "member" = "owner";
  if (ctx.viewingAsStaff) {
    const { data: f } = await admin.from("florists").select("email").eq("id", ctx.floristId).maybeSingle();
    email = f?.email ?? "";
    role = "owner";
  } else {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    const me = await currentFlorist();
    email = user?.email ?? "";
    role = (me?.role as "owner" | "member" | undefined) ?? "owner";
  }

  // Invites are owner-only — never ship them into a member's client payload.
  const [{ data: teamRows }, { data: inviteRows }] = await Promise.all([
    admin.from("florist_users").select("email, role, created_at").eq("florist_id", ctx.floristId).order("created_at"),
    role === "owner"
      ? admin.from("florist_invites").select("id, email, created_at, expires_at").eq("florist_id", ctx.floristId).is("accepted_at", null).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as InviteRow[] }),
  ]);

  return (
    <FloristAccount
      email={email}
      role={role}
      team={teamRows ?? []}
      pendingInvites={inviteRows ?? []}
    />
  );
}
