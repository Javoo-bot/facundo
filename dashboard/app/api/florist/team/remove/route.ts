import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);
  if (me.role !== "owner") return jsonError("Only the account owner can remove teammates.", 403);

  let body: { email?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return jsonError("email is required.", 400);
  if (email === me.email.toLowerCase()) return jsonError("You can't remove yourself.", 400);

  const admin = createServiceClient();
  const { data: target } = await admin
    .from("florist_users").select("role").eq("florist_id", me.floristId).eq("email", email).maybeSingle();
  if (!target) return jsonError("That person isn't on your team.", 404);
  if (target.role === "owner") return jsonError("Can't remove the account owner.", 400);

  const { error } = await admin.from("florist_users")
    .delete().eq("florist_id", me.floristId).eq("email", email);
  if (error) return jsonError(`Failed to remove teammate: ${error.message}`, 500);
  return Response.json({ ok: true });
}
