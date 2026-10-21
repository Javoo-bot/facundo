import { createBrowserClient } from "./supabase";
import { resetUser } from "./analytics";

/** Kicks off Google OAuth from the browser. Called from SignInScreen's button. */
export async function signInWithGoogle() {
  const supabase = createBrowserClient();
  const redirectTo = `${window.location.origin}/auth/callback`;
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });
}

/** Signs out client-side and hard-refreshes so every server component
 * re-checks the (now absent) session. */
export async function signOut(redirectTo: string = "/") {
  const supabase = createBrowserClient();
  await supabase.auth.signOut();
  // The one client-side sign-out path for both surfaces (UserMenu and
  // FloristAccount), so this is the only place PostHog needs unlinking —
  // otherwise the next sign-in on this browser stitches onto the previous
  // person. reset() clears storage synchronously (it cancels the pending
  // debounced write rather than waiting on it), so the assign() below can't
  // race it.
  resetUser();
  window.location.assign(redirectTo);
}

/** Email/password sign-in. On success the session cookie is set and the login
 * is logged server-side (best-effort, fire-and-forget); the caller redirects
 * to "/" where the server components run the isAllowed gate. */
export async function signInWithPassword(email: string, password: string): Promise<{ error: string | null }> {
  const supabase = createBrowserClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) {
    fetch("/api/auth/log-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "password" }),
    }).catch(() => {}); // best-effort — must never block or fail the sign-in
  }
  return { error: error?.message ?? null };
}

/** Sends a password-reset email. The link routes through /auth/callback (code
 * exchange + allow-list gate) then to /auth/reset. */
export async function requestPasswordReset(email: string): Promise<{ error: string | null }> {
  const supabase = createBrowserClient();
  const redirectTo = `${window.location.origin}/auth/callback?next=/auth/reset`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  return { error: error?.message ?? null };
}

/** Sets a new password for the current (recovery) session. */
export async function updatePassword(newPassword: string): Promise<{ error: string | null }> {
  const supabase = createBrowserClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  return { error: error?.message ?? null };
}

