import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { validatePersonaInput } from "@/lib/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Settings → Personas. The named humans the outreach funnel's follow-ups come
// from, one active row per market. Admin-only, service-role writes — same shape
// as app/api/allowlist/route.ts, which is the other staff-managed table here.
//
// There is no DELETE. Retiring a persona DEACTIVATES it (PATCH active:false):
// conversation_messages and (later) voice_calls reference the persona that
// actually sent each message, and hard-deleting the row would either break
// those references or silently reattribute old threads to whoever holds the
// market now.

export async function GET(): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("outreach_personas")
    .select("*")
    .order("active", { ascending: false })
    .order("locale");
  if (error) return jsonError(`Failed to load personas: ${error.message}`, 500);

  return Response.json({ personas: data ?? [] });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const parsed = validatePersonaInput(raw);
  if (!parsed.ok) return jsonError(parsed.message, 400);

  const admin = createServiceClient();
  const { error } = await admin.from("outreach_personas").insert({ ...parsed.value, active: true });
  if (error) {
    // 23505 = the partial unique index (one ACTIVE persona per locale). That's
    // a real conflict worth naming rather than a 500 — the admin needs to know
    // to retire the incumbent first, not to retry.
    if ((error as { code?: string }).code === "23505") {
      return jsonError("That market already has an active persona. Retire it first.", 409);
    }
    return jsonError(`Failed to add persona: ${error.message}`, 500);
  }

  return Response.json({ ok: true });
}

export async function PATCH(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const id = (raw as { id?: unknown })?.id;
  if (typeof id !== "string" || id.length === 0) return jsonError("id is required.", 400);

  const admin = createServiceClient();

  // Retire / restore is its own narrow operation — it takes no other fields, so
  // a toggle can never smuggle in a copy edit.
  const active = (raw as { active?: unknown })?.active;
  if (typeof active === "boolean") {
    const { error } = await admin
      .from("outreach_personas")
      .update({ active, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return jsonError("That market already has an active persona. Retire it first.", 409);
      }
      return jsonError(`Failed to update persona: ${error.message}`, 500);
    }
    return Response.json({ ok: true });
  }

  const parsed = validatePersonaInput(raw);
  if (!parsed.ok) return jsonError(parsed.message, 400);

  const { error } = await admin
    .from("outreach_personas")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return jsonError("That market already has an active persona. Retire it first.", 409);
    }
    return jsonError(`Failed to update persona: ${error.message}`, 500);
  }

  return Response.json({ ok: true });
}
