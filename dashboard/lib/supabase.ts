import {
  createBrowserClient as createSupabaseBrowserClient,
  createServerClient as createSupabaseServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { sharedCookieDomain } from "./hostRouting";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Client component / browser context. Uses the anon key only — RLS on the
 * `authenticated` role is what actually gates data access, enforced by the
 * user's JWT living in cookies. Shares the session cookie across
 * bo.fc.example.net/florist.fc.example.net in production (same as the
 * view-as cookie, lib/viewAs.ts) so a staff session started on one host is
 * readable on the other — required for "view as florist" to work, and
 * matches NoFloristAccount's existing assumption that a staff member can
 * legitimately land on the florist PWA with a real session. */
export function createBrowserClient() {
  const domain = typeof window !== "undefined" ? sharedCookieDomain(window.location.hostname) : undefined;
  return createSupabaseBrowserClient(supabaseUrl, supabaseAnonKey, domain ? { cookieOptions: { domain } } : undefined);
}

/** Server component / route handler context. Reads (and, where possible,
 * writes) the session cookie via next/headers so RLS sees a real
 * `authenticated` role. `setAll` is a no-op-if-it-throws because Server
 * Components can't set cookies (only Server Actions / Route Handlers can) —
 * that's fine here since the OAuth callback route handler is the only place
 * that needs to persist a session cookie. */
export async function createServerClient() {
  // Imported lazily (rather than as a top-level static import) so this
  // module can still export the browser-safe createBrowserClient() to code
  // that also runs in the client bundle (lib/auth.ts's signInWithGoogle /
  // signOut) without Next.js flagging a "next/headers in a Client Component"
  // build error.
  const { cookies, headers } = await import("next/headers");
  const cookieStore = await cookies();
  const domain = sharedCookieDomain((await headers()).get("host"));

  return createSupabaseServerClient(supabaseUrl, supabaseAnonKey, {
    cookieOptions: domain ? { domain } : undefined,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component render — ignore. The route
          // handler (which can write cookies) is what persists the session.
        }
      },
    },
  });
}
