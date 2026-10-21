"use client";

import Link from "next/link";
import { useState } from "react";
import AuthCard from "@/components/AuthCard";
import { signInWithPassword } from "@/lib/auth";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || `Registration failed (${res.status}).`);
        return;
      }
      // Auto sign-in and go to the app.
      const { error: signInError } = await signInWithPassword(email, password);
      if (signInError) { setError(signInError); return; }
      window.location.assign("/");
    } finally { setBusy(false); }
  };

  return (
    <AuthCard title="Create your account">
      <form onSubmit={submit} className="space-y-3">
        <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <input type="password" required placeholder="Password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <input type="password" required placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy}
          className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {busy ? "Creating…" : "Register"}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-500">
        Already have an account? <Link href="/" className="text-emerald-700 hover:underline">Sign in</Link>
      </p>
    </AuthCard>
  );
}
