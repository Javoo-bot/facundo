import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { EDITABLE_DETAIL_FIELDS, validateDetailsUpdate, buildDetailsChangeNote } from "@/lib/floristDetails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const floristId = typeof body.floristId === "string" ? body.floristId.trim() : "";
  if (!floristId) return jsonError("floristId must be a non-empty string.", 400);

  const validated = validateDetailsUpdate(body);
  if (!validated.ok) return jsonError(validated.error, 400);
  const { update } = validated;
  if (Object.keys(update).length === 0) return jsonError("No recognized fields in body.", 400);

  const admin = createServiceClient();

  const { data: current, error: fetchError } = await admin
    .from("florists")
    .select(EDITABLE_DETAIL_FIELDS.join(","))
    .eq("id", floristId)
    .maybeSingle();
  if (fetchError) return jsonError(`Failed to load florist: ${fetchError.message}`, 500);
  if (!current) return jsonError("Florist not found.", 404);

  const { data: updated, error: updateError } = await admin.from("florists").update(update).eq("id", floristId).select("id");
  if (updateError) return jsonError(`Failed to update florist: ${updateError.message}`, 500);
  if (!updated || updated.length === 0) return jsonError("Florist not found.", 404);

  const noteBody = buildDetailsChangeNote(current as unknown as Record<string, string | null>, update);
  if (noteBody) {
    const { error: noteError } = await admin
      .from("florist_notes")
      .insert({ florist_id: floristId, author: gate.email, body: noteBody });
    // Best-effort: the details update already succeeded; don't fail the request
    // over an audit-note write (mirrors florist_tier_changes in operational/route.ts).
    if (noteError) console.error("florist_notes insert failed:", noteError.message);
  }

  return Response.json({ ok: true });
}
