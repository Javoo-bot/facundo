import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isLocale, flattenKeys } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Runtime DB-override layer for the email-string catalog (dashboard/lib/i18n)
// — dashboard/app/(staff)/email-templates is the only caller. Admin-gated
// like Settings itself (this edits what florists/customers actually receive)
// and service-role for the write (message_overrides has no
// insert/update/delete RLS policy — see the migration).

/** A key is only ever valid if it's one of the real EN catalog leaves —
 * rejects typos and made-up keys before they ever reach the DB. */
function isKnownKey(key: unknown): key is string {
  return typeof key === "string" && flattenKeys().includes(key);
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const { locale, key, value } = (body ?? {}) as Record<string, unknown>;

  if (!isLocale(locale)) return jsonError("locale must be one of en/fr/es/it/de.", 400);
  if (!isKnownKey(key)) return jsonError("key is not a recognized message key.", 400);
  if (typeof value !== "string" || value.trim().length === 0) return jsonError("value must be a non-empty string.", 400);

  const admin = createServiceClient();
  const { error } = await admin
    .from("message_overrides")
    .upsert(
      { locale, key, value, updated_by: gate.email, updated_at: new Date().toISOString() },
      { onConflict: "locale,key" }
    );
  if (error) return jsonError(`Failed to save override: ${error.message}`, 500);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const { locale, key } = (body ?? {}) as Record<string, unknown>;

  if (!isLocale(locale)) return jsonError("locale must be one of en/fr/es/it/de.", 400);
  if (!isKnownKey(key)) return jsonError("key is not a recognized message key.", 400);

  const admin = createServiceClient();
  const { error } = await admin.from("message_overrides").delete().eq("locale", locale).eq("key", key);
  if (error) return jsonError(`Failed to revert override: ${error.message}`, 500);
  return Response.json({ ok: true });
}
