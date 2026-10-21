"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import { BRAND } from "@/lib/brand";

// Outside the `.ds` scope, so the brand colour is spelled out here.
const PRIMARY = BRAND === "facundo" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-[#1F4FE0] hover:bg-[#1A43BF]";
const LINK = BRAND === "facundo" ? "text-emerald-700" : "text-[#1F4FE0]";
import { signInWithGoogle, signInWithPassword } from "@/lib/auth";
import { captureEvent } from "@/lib/analytics";

export default function SignInScreen({ error }: { error?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Read `?error=` here rather than threading it down from the server. This is
  // already a client component, and a layout — which is what actually renders
  // this screen for a signed-out visitor — is never given searchParams, so the
  // alternative was forwarding the query string through middleware just to hand
  // it back. The `error` prop still wins where a caller passes one explicitly
  // (the allow-list rejection in app/(staff)/layout.tsx).
  const params = useSearchParams();
  const shown = error ?? params.get("error") ?? undefined;

  // Telemetry only — no navigation, nothing the user can get stuck behind. The
  // matching server-side row (login_failures) carries the real error code; this
  // exists so a failure is visible next to the rest of that person's session,
  // and so PostHog's auto-captured $browser/$raw_user_agent attach to it — the
  // property that would have named a chat app's in-app browser immediately.
  // Keyed on `shown`, so it fires once per distinct outcome rather than per render.
  useEffect(() => {
    if (!shown) return;
    captureEvent("signin_failed", { reason: shown });
  }, [shown]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    const { error: signInError } = await signInWithPassword(email, password);
    if (signInError) {
      setFormError(signInError);
      setBusy(false);
      return;
    }
    window.location.assign("/");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <BrandLogo size={30} className="mx-auto mb-4 h-7 w-auto text-slate-900" style={{ justifyContent: "center", width: "100%" }} />
        <h1 className="text-base font-semibold text-slate-900">
          {BRAND === "facundo" ? "Florist Discovery" : "Order operations"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">Internal demo — sign in to continue.</p>

        {shown === "unauthorized" && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            This email isn&apos;t authorized for the demo. Contact your administrator.
          </p>
        )}

        {/* Distinct from "unauthorized": the person IS allowed, the link just
            couldn't be completed (see app/auth/callback/route.ts). Two different
            flows land here — a sign-in whose PKCE verifier was left behind in a
            chat app's built-in browser, and an expired or already-used password
            reset, since /auth/forgot routes staff AND florists through the same
            callback. The copy has to be true of both, so it names the link rather
            than the sign-in, and the recovery ("open it directly", "start again")
            is the correct advice either way. */}
        {shown === "signin_incomplete" && (
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            We couldn&apos;t complete that link — it may have expired, or it was
            opened in a different browser than it was started in. Open the app
            directly in your browser and sign in below.
          </p>
        )}

        <form onSubmit={submit} className="mt-6 space-y-3 text-left">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          {formError && <p className="text-sm text-red-600">{formError}</p>}
          <button
            type="submit"
            disabled={busy}
            className={`w-full rounded-md ${PRIMARY} px-4 py-2 text-sm font-medium text-white disabled:opacity-50`}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-3 flex justify-between text-sm">
          <Link href="/auth/forgot" className={`${LINK} hover:underline`}>
            Forgot password?
          </Link>
          <Link href="/auth/register" className={`${LINK} hover:underline`}>
            Register
          </Link>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-200" />
          <span className="text-xs uppercase text-slate-400">or</span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>

        <button
          type="button"
          onClick={() => signInWithGoogle()}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.47c-.28 1.5-1.13 2.77-2.4 3.62v3h3.88c2.27-2.09 3.54-5.17 3.54-8.65z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.24 0 5.95-1.08 7.93-2.92l-3.88-3c-1.08.72-2.45 1.15-4.05 1.15-3.11 0-5.75-2.1-6.69-4.93H1.3v3.09C3.26 21.3 7.31 24 12 24z"
            />
            <path
              fill="#FBBC05"
              d="M5.31 14.3a7.2 7.2 0 010-4.6V6.61H1.3a12 12 0 000 10.78z"
            />
            <path
              fill="#EA4335"
              d="M12 4.75c1.76 0 3.34.6 4.59 1.79l3.44-3.44C17.94 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.3 6.61l4.01 3.09C6.25 6.86 8.89 4.75 12 4.75z"
            />
          </svg>
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
