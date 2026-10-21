import { jsonError } from "@/lib/apiAuth";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { ensureFloristUser } from "@/lib/floristLink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return jsonError("Not signed in.", 401);
  // Shared with the florist layout and the magic-link redeem route. This route
  // previously carried its own copy that inserted WITHOUT `email`, a NOT NULL
  // column (supabase/migrations/2026-07-21-florist-team.sql) — so the insert
  // could only ever have failed. One definition now.
  const admin = createServiceClient();
  const floristId = await ensureFloristUser(admin, user.id, user.email);
  if (!floristId) return jsonError("No florist account matches this email. Contact Facundo.", 403);
  return Response.json({ ok: true, florist_id: floristId });
}
