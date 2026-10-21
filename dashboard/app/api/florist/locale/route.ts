import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { isLocale } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Self-service: any signed-in florist (owner or member) sets their own
// account's locale. There's one locale per florist account, not per team
// member — matches florists.locale being a column on `florists`, not
// `florist_users`.
export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);

  let body: { locale?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!isLocale(body.locale)) return jsonError("Unsupported locale.", 400);

  const admin = createServiceClient();
  const { error } = await admin.from("florists").update({ locale: body.locale }).eq("id", me.floristId);
  if (error) return jsonError(`Failed to save locale: ${error.message}`, 500);

  return Response.json({ ok: true });
}
