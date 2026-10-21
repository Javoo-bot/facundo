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

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
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
  const b = (body ?? {}) as {
    floristId?: unknown;
    title?: unknown;
    meetingAt?: unknown;
    outcome?: unknown;
    nextFollowUpAt?: unknown;
  };
  const floristId = typeof b.floristId === "string" ? b.floristId.trim() : "";
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const meetingAt = isoOrNull(b.meetingAt);
  if (!floristId) return jsonError("floristId must be a non-empty string.", 400);
  if (!title) return jsonError("Meeting title must not be empty.", 400);
  if (!meetingAt) return jsonError("meetingAt must be a valid date.", 400);
  const outcome = typeof b.outcome === "string" && b.outcome.trim() ? b.outcome.trim() : null;
  const nextFollowUpAt = isoOrNull(b.nextFollowUpAt);

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("florist_meetings")
    .insert({
      florist_id: floristId,
      title,
      meeting_at: meetingAt,
      outcome,
      next_follow_up_at: nextFollowUpAt,
      created_by: user.email ?? null,
    })
    .select("*")
    .single();

  if (error) return jsonError(`Failed to log meeting: ${error.message}`, 500);
  return Response.json({ ok: true, meeting: data });
}
