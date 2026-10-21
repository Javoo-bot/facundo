import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);
  if (me.role !== "owner") return jsonError("Only the account owner can revoke invites.", 403);

  let body: { inviteId?: string };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.inviteId) return jsonError("inviteId is required.", 400);

  const admin = createServiceClient();
  // Scoped to the caller's own florist_id — an owner can only revoke their own team's invites.
  const { error } = await admin.from("florist_invites")
    .delete().eq("id", body.inviteId).eq("florist_id", me.floristId).is("accepted_at", null);
  if (error) return jsonError(`Failed to revoke invite: ${error.message}`, 500);
  return Response.json({ ok: true });
}
