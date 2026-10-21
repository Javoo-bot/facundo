"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AuthCard from "@/components/AuthCard";
import { createBrowserClient } from "@/lib/supabase";
import { updatePassword } from "@/lib/auth";

export default function ResetPasswordPage() {
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createBrowserClient();
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setHasSession(Boolean(data.session));
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setBusy(true);
    try {
      const { error: updateError } = await updatePassword(password);
      if (updateError) { setError(updateError); return; }
      window.location.assign("/");
    } finally {
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <AuthCard title="Set a new password">
        <p className="text-center text-sm text-slate-500">Checking your link…</p>
      </AuthCard>
    );
  }

  if (!hasSession) {
    return (
      <AuthCard title="Set a new password">
        <p className="text-center text-sm text-red-600">This reset link is invalid or expired.</p>
        <p className="mt-4 text-center text-sm text-slate-500">
          <Link href="/auth/forgot" className="text-emerald-700 hover:underline">Request a new link</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set a new password">
      <form onSubmit={submit} className="space-y-3">
        <input type="password" required placeholder="New password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <input type="password" required placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy}
          className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
    </AuthCard>
  );
}
