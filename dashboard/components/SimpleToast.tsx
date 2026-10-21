"use client";

import { IconAlertTriangle, IconCheckCircle } from "@/components/icons";
import type { ToastItem } from "@/lib/useToasts";

/**
 * Dumb, stacking toast host — bottom-right, matching the visual language of
 * the retired RerunToast (rounded-lg border bg-white shadow-xl, the same
 * `animate-overview-toast-in` keyframe) but without any streaming/log state,
 * since progress now lives in the jobs panel. Each caller owns its own
 * `useToasts()` queue and renders its own <SimpleToast>; `positionClassName`
 * lets two hosts that might be visible at once (e.g. a row's "Re-running…"
 * toast and the jobs panel's "finished ingesting" toast) avoid stacking on
 * top of each other.
 */
export default function SimpleToast({
  toasts,
  onDismiss,
  positionClassName = "bottom-4 right-4",
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  positionClassName?: string;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className={`fixed z-50 flex w-80 flex-col gap-2 ${positionClassName}`}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          aria-live="polite"
          className="flex animate-overview-toast-in items-start gap-2 rounded-lg border border-line bg-surface px-4 py-3 shadow-xl"
        >
          {toast.tone === "success" ? (
            <IconCheckCircle className="h-4 w-4 shrink-0 text-accent" />
          ) : toast.tone === "error" ? (
            <IconAlertTriangle className="h-4 w-4 shrink-0 text-crit" />
          ) : null}
          <span className="min-w-0 flex-1 text-sm text-ink-soft">{toast.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Close"
            className="shrink-0 rounded-md px-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
