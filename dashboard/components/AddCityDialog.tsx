"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AddCityForm from "@/components/AddCityForm";
import BulkAddCityForm from "@/components/BulkAddCityForm";
import { IconCheckCircle } from "@/components/icons";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const TITLE_ID = "add-city-dialog-title";

/**
 * Modal shell around AddCityForm — reuses the HowDataCollectedModal shell
 * pattern (fixed inset-0 overlay, centered white panel) but adds what a
 * data-entry dialog needs that a read-only info modal didn't: a focus trap,
 * a background `inert`ed by the caller, and backdrop/Escape close disabled
 * for the brief moment while POST /api/ingest is in flight (the ingest
 * itself now runs detached in the background — see the jobs panel).
 */
export default function AddCityDialog({
  onClose,
  onIngestSuccess,
}: {
  onClose: () => void;
  /** Called once POST /api/ingest accepts the job — the caller uses this to
   * router.refresh(); the jobs panel picks up progress from there and
   * refreshes again itself once the job actually finishes. */
  onIngestSuccess: () => void;
}) {
  const [isRunning, setIsRunning] = useState(false);
  const [mode, setMode] = useState<"list" | "single">("list");
  const [success, setSuccess] = useState<{ country: string; city: string } | null>(null);
  const [batchSuccess, setBatchSuccess] = useState<{ enqueued: number; skipped: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const requestClose = useCallback(() => {
    if (isRunning) return; // brief window while the POST is in flight
    onClose();
  }, [isRunning, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40 p-4 animate-overview-backdrop-fade"
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-surface p-6 shadow-2xl animate-overview-dialog-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={TITLE_ID} className="text-lg font-semibold text-ink">
            Add cities
          </h2>
          <button
            type="button"
            onClick={requestClose}
            disabled={isRunning}
            aria-label="Close"
            title={isRunning ? "Starting the ingest…" : "Close"}
            className="rounded-md px-2 py-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            &times;
          </button>
        </div>

        {success || batchSuccess ? (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <IconCheckCircle className="h-10 w-10 text-accent" />
            <p className="text-sm font-medium text-ink">
              {success
                ? `Started — ${success.city}, ${success.country} is ingesting in the background.`
                : `Enqueued ${batchSuccess!.enqueued} ${
                    batchSuccess!.enqueued === 1 ? "city" : "cities"
                  }${batchSuccess!.skipped > 0 ? ` · ${batchSuccess!.skipped} skipped` : ""}.`}
            </p>
            <p className="text-xs text-ink-soft">Track progress in the jobs panel.</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-1 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white transition hover:bg-accent-ink active:scale-[0.98]"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 inline-flex rounded-md border border-line p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setMode("list")}
                disabled={isRunning}
                className={`rounded px-2.5 py-1 font-medium ${
                  mode === "list" ? "bg-accent text-white" : "text-ink-soft"
                }`}
              >
                Paste list
              </button>
              <button
                type="button"
                onClick={() => setMode("single")}
                disabled={isRunning}
                className={`rounded px-2.5 py-1 font-medium ${
                  mode === "single" ? "bg-accent text-white" : "text-ink-soft"
                }`}
              >
                Single city
              </button>
            </div>
            <div className="mt-4">
              {mode === "list" ? (
                <BulkAddCityForm
                  onRunningChange={setIsRunning}
                  onBatchSuccess={(summary) => {
                    setBatchSuccess(summary);
                    onIngestSuccess();
                  }}
                />
              ) : (
                <AddCityForm
                  onRunningChange={setIsRunning}
                  onIngestSuccess={(country, city) => {
                    setSuccess({ country, city });
                    onIngestSuccess();
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
