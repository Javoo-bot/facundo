import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { resolveUnsubscribeChannel, buildUnsubscribeUpdate, isTestModeUnsubscribeToken } from "@/lib/unsubscribeChannel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SNOOZE_DAYS = 30;

// Public, no-login endpoint — the standard unsubscribe-link security model
// (token possession is the only credential, same as every other unsubscribe
// link on the web). Never confirms whether a token ever existed beyond a
// generic 404, and never discloses florist identity.
export async function POST(request: Request): Promise<Response> {
  let body: { token?: unknown; action?: unknown; channel?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const action = body.action;
  if (!token) return jsonError("token is required.", 400);
  if (action !== "snooze" && action !== "stop") return jsonError("action must be 'snooze' or 'stop'.", 400);

  // Defaults to 'email' so every unsubscribe link minted before SMS existed
  // (no `channel` param at all) keeps working byte-for-byte. See
  // lib/unsubscribeChannel.ts for the (unit-tested) validation rule.
  const channel = resolveUnsubscribeChannel(body.channel);
  if (channel === null) return jsonError("channel must be 'email' or 'sms'.", 400);

  // Defence in depth. The sentinel already matches no florist row, so the
  // lookup below would 404 anyway — but say so explicitly, so this stays true
  // even if the sentinel were ever (mistakenly) written to a florist row. The
  // preview page renders this token with inert buttons; nothing should ever
  // POST it, and if something does, it must not mutate anyone's preferences.
  if (isTestModeUnsubscribeToken(token)) return jsonError("Link not found.", 404);

  const admin = createServiceClient();
  const { data: florist } = await admin.from("florists").select("id").eq("unsubscribe_token", token).maybeSingle();
  if (!florist) return jsonError("Link not found.", 404);

  const snoozeUntil = new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const update = buildUnsubscribeUpdate(channel, action, snoozeUntil);

  const { error } = await admin.from("florists").update(update).eq("id", florist.id);
  if (error) return jsonError(`Failed to update preferences: ${error.message}`, 500);
  return Response.json({ ok: true });
}
