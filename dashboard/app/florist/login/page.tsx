"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createBrowserClient } from "@/lib/supabase";
import { isSafeDest } from "@/lib/floristMagicLink";
import Button from "@/components/ui/Button";
import BrandLogo from "@/components/BrandLogo";
import { BRAND, BRAND_NAME } from "@/lib/brand";

const field: React.CSSProperties = { height: 44, padding: "0 12px", width: "100%", fontSize: ".92rem" };

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden style={{ flexShrink: 0 }}>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C40.9 36.3 44 30.7 44 24c0-1.3-.1-2.3-.4-3.5z" />
    </svg>
  );
}
function MetaIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden style={{ flexShrink: 0 }}>
      <path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden style={{ flexShrink: 0 }}>
      <path fill="var(--ink)" d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.63 7.58H.49l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93Zm-1.29 19.5h2.04L6.49 3.24H4.3L17.61 20.65Z" />
    </svg>
  );
}
function LinkedInIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden style={{ flexShrink: 0 }}>
      <path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

// Extra social providers (beyond Google). Each must be enabled in the Supabase
// Auth dashboard with the provider's own OAuth app credentials; until then,
// signInWithOAuth returns a "provider is not enabled" error, surfaced inline.
// Hidden until those providers are actually wired up — flip this back on then.
const SOCIALS_ENABLED = false;
const SOCIALS: { id: string; label: string; Icon: () => React.ReactElement }[] = [
  { id: "facebook", label: "Meta", Icon: MetaIcon },
  { id: "twitter", label: "X", Icon: XIcon },
  { id: "linkedin_oidc", label: "LinkedIn", Icon: LinkedInIcon },
];

export default function FloristLogin() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invite = searchParams.get("invite");
  // Where to land after signing in. Set by app/florist/(app)/layout.tsx when it
  // bounces a deep link, and by the magic-link route when a token has gone
  // stale — so an expired link is a detour to sign-in, not a dead end that
  // dumps the florist on the home screen. Validated with the shared isSafeDest
  // guard: a `next` from the query string must never become an open redirect.
  const nextParam = searchParams.get("next");
  const reason = searchParams.get("reason");
  // An invite takes precedence: it's a one-time join flow that must complete.
  const dest = invite ? `/florist/join?invite=${invite}` : isSafeDest(nextParam) ? nextParam! : "/florist";
  const supabase = createBrowserClient();
  const [method, setMethod] = useState<"code" | "password">("code");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function oauth(provider: string) {
    setBusy(provider);
    setMsg(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider string covers all enabled Supabase OAuth providers
    const { error } = await supabase.auth.signInWithOAuth({ provider: provider as any, options: { redirectTo: `${location.origin}${dest}` } });
    if (error) {
      setMsg(error.message);
      setBusy(null);
    }
  }
  async function sendCode() {
    setBusy("code");
    setMsg(null);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    setBusy(null);
    if (error) setMsg(error.message);
    else setSent(true);
  }
  // Fire-and-forget: the server resolves who signed in from the now-set session
  // cookie, so a logging failure can never cost the florist their sign-in.
  function logLogin(method: "otp" | "password") {
    fetch("/api/auth/log-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method }),
    }).catch(() => {});
  }

  async function verify() {
    setBusy("verify");
    setMsg(null);
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
    setBusy(null);
    if (error) setMsg(error.message);
    else {
      logLogin("otp");
      router.push(dest);
    }
  }
  async function signInWithPass() {
    setBusy("pw");
    setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(null);
    if (error) setMsg(error.message);
    else {
      logLogin("password");
      router.push(dest);
    }
  }

  return (
    <div className="ds" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20, background: "var(--bg)" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <BrandLogo size={30} style={{ height: 30, width: "auto", margin: "0 auto 14px", display: "flex", justifyContent: "center", color: "var(--ink)" }} />
          <p className="eyebrow">Florist</p>
          <h1 style={{ marginTop: 6 }}>Welcome back</h1>
          <p style={{ color: "var(--ink-soft)", fontSize: ".9rem", marginTop: 6 }}>Sign in to see your orders and payouts.</p>
          {invite && (
            <p style={{ marginTop: 10, fontSize: ".85rem", color: "var(--accent)" }}>
              You&apos;ve been invited to join a florist team on {BRAND_NAME[BRAND]}. Sign in
              with the email the invite was sent to.
            </p>
          )}
          {!invite && reason && (
            <p style={{ marginTop: 10, fontSize: ".85rem", color: "var(--ink-soft)" }}>
              {reason === "staff-no-impersonate"
                ? "That link belongs to a florist account. Sign in as the florist to open it."
                : "That link has expired. Sign in and we'll take you straight there."}
            </p>
          )}
        </div>

        <div className="card" style={{ display: "grid", gap: 14, padding: 20 }}>
          <button type="button" className="btn" onClick={() => oauth("google")} disabled={!!busy} style={{ justifyContent: "center", height: 44, fontSize: ".9rem", gap: 10 }}>
            <GoogleIcon />
            {busy === "google" ? "Redirecting…" : "Continue with Google"}
          </button>

          <div style={{ display: "flex", gap: 8 }}>
            {SOCIALS_ENABLED && SOCIALS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="btn"
                onClick={() => oauth(s.id)}
                disabled={!!busy}
                aria-label={`Continue with ${s.label}`}
                title={`Continue with ${s.label}`}
                style={{ flex: 1, justifyContent: "center", height: 44 }}
              >
                {busy === s.id ? "…" : <s.Icon />}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            <span style={{ color: "var(--ink-faint)", font: "600 .68rem/1 var(--mono)", letterSpacing: ".12em", textTransform: "uppercase" }}>or with email</span>
            <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>

          <input
            type="email"
            placeholder="you@shop.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (sent) setSent(false); }}
            autoComplete="email"
            style={field}
          />

          {!sent ? (
            <>
              <div className="segmented" role="tablist" aria-label="Sign-in method" style={{ width: "100%" }}>
                <button type="button" role="tab" aria-selected={method === "code"} className={method === "code" ? "on" : ""} onClick={() => { setMethod("code"); setMsg(null); }} style={{ flex: 1 }}>
                  Email a code
                </button>
                <button type="button" role="tab" aria-selected={method === "password"} className={method === "password" ? "on" : ""} onClick={() => { setMethod("password"); setMsg(null); }} style={{ flex: 1 }}>
                  Password
                </button>
              </div>

              {method === "code" ? (
                <Button variant="solid" onClick={sendCode} disabled={!email || !!busy} style={{ justifyContent: "center", height: 44 }}>
                  {busy === "code" ? "Sending…" : "Email me a code"}
                </Button>
              ) : (
                <>
                  <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" style={field} />
                  <Button variant="solid" onClick={signInWithPass} disabled={!email || !password || !!busy} style={{ justifyContent: "center", height: 44 }}>
                    {busy === "pw" ? "Signing in…" : "Sign in"}
                  </Button>
                  <Link href="/auth/forgot" style={{ textAlign: "center", fontSize: ".8rem", color: "var(--ink-soft)" }}>
                    Forgot password?
                  </Link>
                </>
              )}
            </>
          ) : (
            <>
              <p style={{ fontSize: ".85rem", color: "var(--ink-soft)", textAlign: "center" }}>
                We emailed a 6-digit code to <b style={{ color: "var(--ink)" }}>{email}</b>.
              </p>
              <input
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoFocus
                style={{ ...field, textAlign: "center", letterSpacing: ".4em", fontFamily: "var(--mono)", fontSize: "1.1rem" }}
              />
              <Button variant="solid" onClick={verify} disabled={code.length < 6 || !!busy} style={{ justifyContent: "center", height: 44 }}>
                {busy === "verify" ? "Verifying…" : "Verify & sign in"}
              </Button>
              <button type="button" className="btn btn-ghost" onClick={() => { setSent(false); setCode(""); setMsg(null); }} style={{ justifyContent: "center" }}>
                Use a different email
              </button>
            </>
          )}

          {msg && (
            <div
              role="alert"
              style={{
                background: "color-mix(in srgb, var(--crit) 10%, transparent)",
                color: "var(--crit)",
                border: "1px solid color-mix(in srgb, var(--crit) 30%, var(--line))",
                borderRadius: 8, padding: "8px 12px", fontSize: ".82rem",
              }}
            >
              {msg}
            </div>
          )}
        </div>

        <p style={{ textAlign: "center", color: "var(--ink-faint)", fontSize: ".75rem", marginTop: 16 }}>
          Trouble signing in? Contact {BRAND_NAME[BRAND]}.
        </p>
      </div>
    </div>
  );
}
