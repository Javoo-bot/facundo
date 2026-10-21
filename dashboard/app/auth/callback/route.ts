import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { isAllowed } from "@/lib/allowlist";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { logLoginEvent } from "@/lib/loginEvents";
import { logLoginFailure } from "@/lib/loginFailures";

// OAuth callback: Google -> Supabase -> here, with ?code=... in the query
// string. Exchanges the code for a session, then enforces the hard-coded
// email allow list before letting the session stand.
//
// Every exit that is NOT a completed sign-in writes a login_failures row, so a
// failed login is answerable from SQL instead of by hand-comparing
// auth.users.last_sign_in_at against login_events (which is how the 2026-08-11
// Google-Chat incident had to be diagnosed). The console.error stays alongside
// it: it's what `wrangler tail` shows live, and it still works when the write
// itself is what's broken.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next");
  const safeNext = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";
  const context = {
    host: request.headers.get("host"),
    nextParam,
    userAgent: request.headers.get("user-agent"),
  };

  if (code) {
    const supabase = await createServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    // The exchange failing is NOT an authorization problem, and conflating the
    // two cost a long debug once already. Two distinct flows fail here:
    //
    //  - A split cookie jar: the link was opened in a chat app's in-app browser
    //    (Google Chat, Slack, Teams), which is where the PKCE code verifier was
    //    written, but Google hands the redirect back to the system browser,
    //    which doesn't have it. Every retry from that link fails identically,
    //    and clearing cookies cannot help — the cookie is in another browser.
    //  - An expired or already-used password-reset link, which arrives here via
    //    lib/auth.ts's requestPasswordReset for STAFF AND FLORISTS ALIKE
    //    (app/florist/login/page.tsx links /auth/forgot too). Anything added on
    //    this path has to be correct for a florist, not just a staff Google
    //    sign-in — which is why this only reports, and never re-initiates.
    //
    // The bounce lands in the browser that DID receive the redirect, so starting
    // over from that page is what succeeds.
    if (error) {
      console.error(
        "auth/callback: code exchange failed",
        JSON.stringify({ code: error.code, status: error.status, message: error.message }),
      );
      await logLoginFailure(createServiceClient(), {
        stage: "code_exchange",
        reason: error.code ?? null,
        detail: error.message,
        ...context,
      });
      return NextResponse.redirect(`${origin}/?error=signin_incomplete`);
    }

    if (data.user) {
      if (await isAllowed(data.user.email)) {
        const admin = createServiceClient();
        await logLoginEvent(admin, {
          surface: "staff",
          method: "google",
          userEmail: data.user.email,
          userAgent: request.headers.get("user-agent"),
        });
        return NextResponse.redirect(`${origin}${safeNext}`);
      }
      // Not on the allow list: no session should persist. This is the ONE
      // failure where the email is known, which is exactly what makes it worth
      // recording — it answers "who tried and was turned away".
      await logLoginFailure(createServiceClient(), {
        stage: "not_allowed",
        userEmail: data.user.email,
        ...context,
      });
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/?error=unauthorized`);
    }
  }

  // Reached with no `code` at all, so there is nothing to exchange and nobody to
  // authorize — "unauthorized" would again be blaming the wrong thing. The known
  // way to land here is a magic link generated in the Supabase console: it has no
  // PKCE verifier, so GoTrue mints the session and returns the tokens in the URL
  // *fragment*, which never reaches the server. This route only implements the
  // `?code=` exchange, so that flow cannot complete — sign in with Google, or with
  // the password form, instead.
  console.error("auth/callback: reached with no code", JSON.stringify({ next: nextParam }));
  await logLoginFailure(createServiceClient(), { stage: "no_code", ...context });
  return NextResponse.redirect(`${origin}/?error=signin_incomplete`);
}
