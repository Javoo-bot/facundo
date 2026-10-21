"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Earned } from "@/components/florist/CelebrationModal";
import { useT } from "@/components/florist/LocaleProvider";

export type AcceptResult =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "success" }
  | { kind: "taken" }
  | { kind: "error"; message: string };

/** Shared "accept an offer" flow for the inbox detail page and the history
 * "changed your mind? accept" re-accept button. Calls the respond API and
 * classifies the outcome into a friendly inline state instead of an
 * `alert()` — success, "someone else took it" (409 / `code: "taken"`), or a
 * generic error. Never throws to the caller. */
export function useAcceptOffer(onEarned?: (earned: Earned) => void) {
  const router = useRouter();
  const { t } = useT();
  const [result, setResult] = useState<AcceptResult>({ kind: "idle" });

  async function accept(assignmentId: string) {
    setResult({ kind: "busy" });
    let res: Response;
    try {
      res = await fetch("/api/florist/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId, action: "accept" }),
      });
    } catch {
      setResult({ kind: "error", message: t("ui.offer.feedback.networkError") });
      return;
    }

    let body: { ok?: boolean; accepted?: boolean; code?: string; error?: string; earned?: Earned | null } = {};
    try { body = await res.json(); } catch { /* empty/non-JSON body */ }

    if (body.code === "taken" || res.status === 409) {
      setResult({ kind: "taken" });
      router.refresh();
      return;
    }
    if (res.ok) {
      setResult({ kind: "success" });
      // Celebrate a balance increase before the soft refresh (which re-renders
      // the server tree but preserves this client component's state).
      if (body.earned && onEarned) onEarned(body.earned);
      router.refresh();
      return;
    }
    setResult({ kind: "error", message: body.error ?? t("ui.offer.feedback.genericError") });
  }

  function reset() {
    setResult({ kind: "idle" });
  }

  return { result, accept, reset };
}
