import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { validateAcceptSubmission, buildAcceptUpdate } from "@/lib/floristAccept";
import { trackRecruitJoined } from "@/lib/reachout/events";
import { shouldBumpToOnboarding } from "@/lib/pipeline";
import { countryToRegion } from "@/lib/phone";
import { mintMagicLink } from "@/lib/floristMagicLinkMint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, no-login endpoint — token possession is the only credential, same
// model as app/api/florist/unsubscribe/route.ts. Never used by staff.
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return jsonError("token is required.", 400);

  const admin = createServiceClient();
  const { data: florist, error: lookupError } = await admin
    .from("florists")
    .select("id, city_id, lifecycle_stage, join_token_expires_at, joined_at")
    .eq("join_token", token)
    .maybeSingle();
  if (lookupError) console.error("florist/accept: token lookup failed", lookupError.message);
  if (!florist) return jsonError("Link not found.", 404);
  // Re-running the form is ALLOWED. A florist who mistypes their address, gets
  // a new mobile, or changes their hours had no way back in — the link they
  // were sent simply stopped working, and they had to ask us. The token is
  // still the credential and still expires; joining twice is just editing.
  // `joined_at` is preserved below so a re-run cannot rewrite their history.
  if (florist.join_token_expires_at && new Date(florist.join_token_expires_at).getTime() <= Date.now()) {
    return jsonError("This link has expired.", 410);
  }

  // The florist's country, so they can type a national mobile ("612 34 56 78")
  // rather than being made to produce "+34…". Looked up AFTER the token checks
  // — an invalid link shouldn't cost a query.
  const { data: city } = florist.city_id
    ? await admin.from("cities").select("country").eq("id", florist.city_id).maybeSingle()
    : { data: null };
  const validated = validateAcceptSubmission(body, countryToRegion(city?.country ?? null));
  if (!validated.ok) return jsonError(validated.error, 400);

  const update = buildAcceptUpdate(validated.values, new Date().toISOString(), florist.joined_at);
  if (shouldBumpToOnboarding(florist.lifecycle_stage)) update.lifecycle_stage = "onboarding";

  const { error: updateError } = await admin.from("florists").update(update).eq("id", florist.id);
  if (updateError) return jsonError(`Failed to save: ${updateError.message}`, 500);

  // Best-effort audit note — a failure here must not fail the request, same
  // convention as lib/floristDetails.ts's change-note insert.
  const { error: noteError } = await admin.from("florist_notes").insert({
    florist_id: florist.id,
    author: "florist self-registration",
    body: "Florist self-registered via network-join link — confirmed contact details and hours.",
  });
  if (noteError) console.error("florist/accept: note insert failed", noteError.message);

  // The welcome message they'll land on. Body is not stored — `kind` selects an
  // i18n catalog entry rendered at read time (app/florist/(app)/messages/[id]).
  //
  // BEST-EFFORT, and the destination follows what actually happened: joining
  // must never fail because a welcome note didn't write. `upsert` on the
  // (florist_id, kind) unique index rather than `insert` so a retried submit
  // returns the existing row instead of erroring on the conflict.
  let welcomeId: string | null = null;
  const { data: welcome, error: welcomeError } = await admin
    .from("florist_messages")
    .upsert({ florist_id: florist.id, kind: "welcome" }, { onConflict: "florist_id,kind" })
    .select("id")
    .maybeSingle();
  if (welcomeError) console.error("florist/accept: welcome message insert failed", welcomeError.message);
  else welcomeId = welcome?.id ?? null;

  // Land the florist INSIDE the signed-in app rather than on a "thanks" card:
  // they just proved control of this join link and typed their own details, so
  // making them sign in from scratch — most have no auth user yet — is a wall
  // at the exact moment they're most engaged.
  //
  // Not gated on test_mode: unlike an offer email, this URL is returned to the
  // browser that just submitted the form, never mailed to a shared test inbox.
  // It signs in as the florist whose token was just redeemed — the same party.
  let signInUrl: string | null = null;
  try {
    signInUrl = await mintMagicLink(admin, {
      floristId: florist.id,
      // Deep-link straight to the welcome message. Falls back to the florist
      // home if the message didn't write — never link to an id that isn't
      // there, which would land them on a 404 as their first impression.
      dest: welcomeId ? `/florist/messages/${welcomeId}` : "/florist",
      purpose: "onboarding",
    });
  } catch (e) {
    // Onboarding already succeeded above; a mint failure must not turn that
    // into a 500. They fall back to the ordinary sign-in.
    console.error("florist/accept: magic link mint failed", e);
  }

  // The funnel's terminal event. Only on the FIRST completion — `joined_at` is
  // preserved by buildAcceptUpdate, so a florist editing their details later
  // must not look like a second conversion.
  if (!florist.joined_at) {
    await trackRecruitJoined(florist.id as string, {});
  }

  return Response.json({ ok: true, signInUrl });
}
