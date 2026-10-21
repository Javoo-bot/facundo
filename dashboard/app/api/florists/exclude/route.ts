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
  // AUTH GATE — session + allow-list, same pattern as /api/ingest and /api/jobs.
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
  const floristId = (body as { floristId?: unknown })?.floristId;
  if (typeof floristId !== "string" || floristId.trim().length === 0) {
    return jsonError("floristId must be a non-empty string.", 400);
  }
  const restore = (body as { restore?: unknown })?.restore === true;

  // Service-role write (RLS has no update policy on florists). Auth-gated above.
  const admin = createServiceClient();
  const newValue = restore ? null : new Date().toISOString();

  // Denylisting is by physical shop, not by row. The same storefront can exist as
  // more than one florist record — ingest upserts on (city_id, place_id), so a shop
  // inside two cities' ingest radii is stored once per city (same place_id, different
  // id). Excluding one record must exclude every sibling sharing its place_id, or
  // the shop keeps receiving offers through its other record: matching only drops
  // rows ALREADY carrying excluded_at (see lib/match.ts::passesHardFilter, which runs
  // before the place_id collapse), so a non-excluded sibling sails straight through.
  // A florist with no place_id can't be identified across rows → toggled by id alone.
  const { data: target, error: lookupErr } = await admin
    .from("florists").select("id, place_id").eq("id", floristId).maybeSingle();
  if (lookupErr) return jsonError(`Failed to ${restore ? "restore" : "exclude"} florist: ${lookupErr.message}`, 500);
  if (!target) return jsonError("Florist not found.", 404);

  const update = admin.from("florists").update({ excluded_at: newValue });
  const { data, error } = target.place_id
    ? await update.eq("place_id", target.place_id).select("id")
    : await update.eq("id", floristId).select("id");

  if (error) return jsonError(`Failed to ${restore ? "restore" : "exclude"} florist: ${error.message}`, 500);
  if (!data || data.length === 0) return jsonError("Florist not found.", 404);

  return Response.json({ ok: true, excludedAt: newValue, affected: data.length });
}
