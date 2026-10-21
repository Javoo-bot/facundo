"use client";

import { useCallback, useRef, useState } from "react";

export type ToastTone = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
}

const DEFAULT_AUTO_DISMISS_MS = 3000;

/**
 * Minimal transient-toast queue, shared by every place that used to show a
 * long-lived streaming panel (RerunToast) and now just needs a brief
 * "started"/"failed" notice for a fire-and-forget POST (see
 * docs/superpowers/specs/2026-07-02-background-jobs-design.md). Deliberately
 * has no cross-component state (Context/store) — each caller owns its own
 * queue and renders its own <SimpleToast>, matching this codebase's existing
 * pattern of transient UI living next to the action that triggered it.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, autoDismissMs: number | null = DEFAULT_AUTO_DISMISS_MS) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, tone, message }]);
      if (autoDismissMs != null) {
        const timer = setTimeout(() => dismiss(id), autoDismissMs);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [dismiss]
  );

  return { toasts, push, dismiss };
}
