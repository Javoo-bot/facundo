import { isAllowed, getStaffRole } from "@/lib/allowlist";
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
  const b = (body ?? {}) as { floristId?: unknown; body?: unknown };
  const floristId = typeof b.floristId === "string" ? b.floristId.trim() : "";
  const noteBody = typeof b.body === "string" ? b.body.trim() : "";
  if (!floristId) return jsonError("floristId must be a non-empty string.", 400);
  if (!noteBody) return jsonError("Note body must not be empty.", 400);

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("florist_notes")
    .insert({ florist_id: floristId, author: user.email ?? null, body: noteBody })
    .select("*")
    .single();

  if (error) return jsonError(`Failed to add note: ${error.message}`, 500);
  return Response.json({ ok: true, note: data });
}
