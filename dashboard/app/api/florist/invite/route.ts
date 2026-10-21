import { randomUUID } from "node:crypto";
import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Owner invites a teammate by email. No email is actually sent (matches this
// project's "drafts generated, not sent" outreach convention) — the returned link
// is copied/shared by the owner however they like.
export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);
  if (me.role !== "owner") return jsonError("Only the account owner can invite teammates.", 403);

  let body: { email?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return jsonError("Enter a valid email address.", 400);

  const admin = createServiceClient();
  const { data: existingMember } = await admin
    .from("florist_users").select("user_id").eq("florist_id", me.floristId).eq("email", email).maybeSingle();
  if (existingMember) return jsonError("That person is already on your team.", 400);

  const token = randomUUID();
  const { error } = await admin.from("florist_invites").upsert(
    { florist_id: me.floristId, email, token, invited_by: me.email, accepted_at: null, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
    { onConflict: "florist_id,email" }
  );
  if (error) return jsonError(`Failed to create invite: ${error.message}`, 500);

  const origin = new URL(request.url).origin;
  return Response.json({ ok: true, inviteUrl: `${origin}/florist/invite/${token}` });
}
