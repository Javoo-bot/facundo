import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { markOfferOpened } from "@/lib/offerOpened";
import { isAllowed, getStaffRole } from "@/lib/allowlist";
import { ensureFloristUser } from "@/lib/floristLink";
import { VIEW_AS_COOKIE, VIEW_AS_TTL_MS, newClaim, encodeClaim } from "@/lib/viewAs";
import { sharedCookieDomain } from "@/lib/hostRouting";
import { magicTokenBlockReason, loginFallbackPath, type MagicTokenBlockReason } from "@/lib/floristMagicLink";
import { logLoginEvent } from "@/lib/loginEvents";
import { setActingFlorist } from "@/lib/floristActing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Magic-link redeem: one click from an offer email / SMS / issue notification
 * signs the florist in and drops them on the order the message was about.
 *
 * A Route Handler rather than a page on purpose — only handlers can write
 * cookies, and establishing the session IS the point.
 *
 * The URL carries only the token. The destination lives on the token row, so
 * there is no redirect parameter in the emailed link to tamper with (and it is
 * re-validated by magicTokenBlockReason before we redirect anywhere).
 */

/** Roles allowed to land in read-only view-as instead of having their staff
 * session swapped. Mirrors lib/viewAs.ts's own ROLES_ALLOWED — kept in step
 * with it deliberately; a role that can't impersonate gets the login bounce. */
const VIEW_AS_ROLES = new Set(["ops", "admin"]);

function bounce(request: Request, dest: string | null, reason: MagicTokenBlockReason | "staff-no-impersonate") {
  const { origin } = new URL(request.url);
  // loginFallbackPath only knows the token reasons; the staff-role case reuses
  // the same shape so the login page has one `reason` param to render.
  const path =
    reason === "staff-no-impersonate"
      ? `/florist/login?next=${encodeURIComponent(dest && dest.startsWith("/") && !dest.startsWith("//") ? dest : "/florist")}&reason=staff-no-impersonate`
      : loginFallbackPath(dest, reason);
  return NextResponse.redirect(`${origin}${path}`);
}

export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const { origin } = new URL(request.url);
  const admin = createServiceClient();

  // The sentinel short-circuits inside magicTokenBlockReason before this row
  // matters, but we still look up first so a real token gets one round trip.
  const { data: row, error: lookupError } = await admin
    .from("florist_magic_tokens")
    .select("token, florist_id, dest, expires_at, revoked_at, assignment_id")
    .eq("token", token)
    .maybeSingle();
  if (lookupError) console.error("florist/m/[token]: lookup failed", lookupError.message);

  const blocked = magicTokenBlockReason(token, row ?? null, new Date());
  if (blocked) return bounce(request, row?.dest ?? null, blocked);

  const dest = row!.dest;
  const floristId = row!.florist_id;
  // The offer this link was minted for, if any. Redeeming it IS the florist
  // opening the offer — see lib/offerOpened.ts for why that beats an open pixel.
  const assignmentId = row!.assignment_id as string | null;

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Already signed in as THIS florist — nothing to do but deep-link. Covers
  // the common case of a florist who lives in the installed PWA and taps a
  // link from an email on the same device.
  if (user) {
    const { data: mapping } = await admin
      .from("florist_users")
      .select("florist_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (mapping?.florist_id === floristId) {
      // Re-stamp on every visit so an active florist's claim never lapses back
      // to the florist_users lookup, which for a shared inbox names a different
      // shop entirely.
      await setActingFlorist(floristId, user.id, (await headers()).get("host"));
      await markOfferOpened(admin, assignmentId);
      await markUsed(admin, token);
      return NextResponse.redirect(`${origin}${dest}`);
    }

    // A staffer opening a real florist message must NOT be silently signed out
    // of the backoffice and into a florist account. Keep their session and use
    // the existing read-only impersonation instead.
    if (await isAllowed(user.email)) {
      const role = await getStaffRole(user.email);
      if (!role || !VIEW_AS_ROLES.has(role)) return bounce(request, dest, "staff-no-impersonate");
      const jar = await cookies();
      const host = (await headers()).get("host");
      jar.set(VIEW_AS_COOKIE, encodeClaim(newClaim(floristId, user.email!)), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: Math.floor(VIEW_AS_TTL_MS / 1000),
        domain: sharedCookieDomain(host),
      });
      await markUsed(admin, token);
      return NextResponse.redirect(`${origin}${dest}`);
    }
    // Signed in as a DIFFERENT florist. Two ways to arrive here: a shared
    // device, or — far more often — a shared inbox, where this shop and the one
    // already mapped hold the same address and `florist_users` can only name
    // one of them.
    //
    // This used to fall through and re-run the whole sign-in, which could not
    // help: user_id is the primary key of florist_users, so the swap had
    // nowhere to write. Now the token says which shop on the session itself,
    // which is what it was always supposed to mean.
    if (mapping) {
      await setActingFlorist(floristId, user.id, (await headers()).get("host"));
      await markOfferOpened(admin, assignmentId);
      await markUsed(admin, token);
      return NextResponse.redirect(`${origin}${dest}`);
    }
  }

  // Sign in as the token's florist.
  const { data: florist } = await admin
    .from("florists")
    .select("email")
    .eq("id", floristId)
    .is("deleted_at", null)
    .maybeSingle();
  const email = florist?.email?.trim().toLowerCase();
  if (!email) {
    console.error("florist/m/[token]: florist has no email", floristId);
    return bounce(request, dest, "not-found");
  }

  // generateLink creates the auth user for `magiclink` when none exists —
  // which is the majority case here, since most florists were ingested and
  // emailed offers without ever signing in. The OTP it returns is consumed
  // server-side immediately below, so its own ~1h Supabase expiry never
  // reaches the florist; OUR 30-day row is what lives in their inbox.
  const { data: link, error: genError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const hashedToken = link?.properties?.hashed_token;
  if (genError || !hashedToken) {
    console.error("florist/m/[token]: generateLink failed", genError?.message ?? "no hashed_token");
    return bounce(request, dest, "not-found");
  }

  // verifyOtp on the SSR client is what actually writes the session cookies.
  const { data: session, error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: hashedToken,
    type: "email",
  });
  if (verifyError || !session.user) {
    console.error("florist/m/[token]: verifyOtp failed", verifyError?.message ?? "no user");
    return bounce(request, dest, "not-found");
  }

  // Map the (possibly brand-new) auth user to this florist. Pass the id from
  // the token rather than relying on the email lookup: the token is the
  // authority on which florist this is.
  //
  // This CAN legitimately fail to write, and used to fail silently. `user_id` is
  // the primary key of florist_users and there is a unique index allowing one
  // owner per shop, so a shop whose stored address no longer matches the one its
  // owner signed up with mints a different auth user whose row cannot be
  // inserted. The florist then landed in the app signed in as nobody, with every
  // API answering 401 and only a console.error to show for it.
  const mapped = await ensureFloristUser(admin, session.user.id, email, floristId);

  // Either way, the session now says which shop this link was for. When the
  // mapping wrote, this is belt and braces; when it could not, this IS the
  // florist's identity and the only thing standing between them and a 401.
  await setActingFlorist(floristId, session.user.id, (await headers()).get("host"));
  if (!mapped) {
    // Worth knowing about: it means the shop's address and its owner's login
    // have drifted apart, which no amount of clicking will fix by itself.
    console.error("florist/m/[token]: no florist_users mapping written; running on the acting claim", floristId);
  }

  // Only the fresh-sign-in branch logs a login: the two branches above are an
  // already-signed-in florist deep-linking and a staff view-as, neither of
  // which is a sign-in.
  await logLoginEvent(admin, {
    surface: "florist",
    method: "magic_link",
    floristId,
    userAgent: request.headers.get("user-agent"),
  });

  // Deliberately NOT on the staff view-as branch above: a staffer reading a
  // florist's message is not the florist opening the offer.
  await markOfferOpened(admin, assignmentId);
  await markUsed(admin, token);
  return NextResponse.redirect(`${origin}${dest}`);
}

/** Best-effort usage stamp. A failure here must never cost the florist their
 * click — same convention as the audit-note inserts elsewhere. A use_count far
 * above 1 is the signal that a link was forwarded around. */
async function markUsed(admin: ReturnType<typeof createServiceClient>, token: string): Promise<void> {
  const { error } = await admin.rpc("bump_magic_token_use", { p_token: token });
  if (error) console.error("florist/m/[token]: markUsed failed", error.message);
}
