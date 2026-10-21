"use client";

import { useState } from "react";
import type { City } from "@/lib/types";

/**
 * Confirm dialog for a city re-run. The checkbox opts into a delete-first
 * reset (soft-delete existing florists before scraping). Reused by both
 * re-run entry points (city page + overview row). Modeled on the app's
 * existing centered-modal convention (backdrop + Escape-free simple panel;
 * it's a low-stakes confirm, not a data-entry flow).
 */
export default function RerunConfirmDialog({
  city,
  floristCount,
  onConfirm,
  onCancel,
}: {
  city: City;
  floristCount: number | null;
  onConfirm: (resetExisting: boolean) => void;
  onCancel: () => void;
}) {
  const [reset, setReset] = useState(false);
  const countLabel = floristCount != null ? `the ${floristCount} existing` : "the existing";

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Re-run ${city.city}`}
        className="w-full max-w-md rounded-lg bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink">
          Re-run {city.city}, {city.country}?
        </h2>
        <label className="mt-4 flex items-start gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={reset}
            onChange={(e) => setReset(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Delete {countLabel} florists first
            <span className="mt-0.5 block text-xs text-ink-faint">
              Soft delete — they’re hidden, not erased; any that reappear come back. If the
              run fails before scraping finishes, the city stays empty until a successful re-run.
            </span>
          </span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reset)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-ink"
          >
            Re-run
          </button>
        </div>
      </div>
    </div>
  );
}
