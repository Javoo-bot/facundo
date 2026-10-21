import { isAllowed, getStaffRole } from "@/lib/allowlist";
import { isLifecycleStage } from "@/lib/pipeline";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError("Not signed in.", 401);
  if (!(await isAllowed(user.email))) return jsonError("This account is not authorized.", 403);
  const role = await getStaffRole(user.email);
  if (!role || !["ops", "admin"].includes(role)) return jsonError("Your role doesn't allow this.", 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const b = (body ?? {}) as { floristId?: unknown; stage?: unknown };
  const floristId = typeof b.floristId === "string" ? b.floristId.trim() : "";
  if (!floristId) return jsonError("floristId must be a non-empty string.", 400);
  // Validate against the allowed set — never trust a client-supplied stage.
  if (!isLifecycleStage(b.stage)) return jsonError("Invalid stage.", 400);

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("florists")
    .update({ lifecycle_stage: b.stage })
    .eq("id", floristId)
    .select("id");

  if (error) return jsonError(`Failed to update stage: ${error.message}`, 500);
  if (!data || data.length === 0) return jsonError("Florist not found.", 404);
  return Response.json({ ok: true, stage: b.stage });
}
