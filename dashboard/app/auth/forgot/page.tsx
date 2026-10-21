"use client";

import Link from "next/link";
import { useState } from "react";
import AuthCard from "@/components/AuthCard";
import { requestPasswordReset } from "@/lib/auth";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Intentionally ignore the returned error — always show the same
      // success message so this endpoint can't be used to enumerate which
      // emails have accounts.
      await requestPasswordReset(email);
    } finally {
      setBusy(false);
      setSubmitted(true);
    }
  };

  return (
    <AuthCard title="Reset your password">
      {submitted ? (
        <p className="text-center text-sm text-slate-600">
          If that email has an account, a reset link is on its way.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <button type="submit" disabled={busy}
            className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
      <p className="mt-4 text-center text-sm text-slate-500">
        <Link href="/" className="text-emerald-700 hover:underline">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}
