"use client";

import { useEffect, useState } from "react";
import SimpleToast from "@/components/SimpleToast";
import { useToasts } from "@/lib/useToasts";
import type { City } from "@/lib/types";

/**
 * Enrichment repair — re-run enrichment for florists we already have, whose
 * last attempt failed and left them with a website but no email. No Apify
 * scrape, nothing billed there.
 *
 * Two shapes, one component, because the only real difference is scope:
 *   scope="all"  — every city with repairable florists (Discovery header)
 *   city={...}   — this city alone (city page, next to Re-run)
 *
 * The button LABELS ITSELF from a live count, so nobody fires a job to find
 * out whether there was anything to do. It disables itself at zero, which is
 * also what a fully-repaired estate looks like.
 */
export default function RepairButton({
  scope,
  city,
  onSuccess,
  className = "",
  buttonClassName,
}: {
  scope: "all" | "city";
  /** Required when scope is "city"; ignored otherwise. */
  city?: City | null;
  /** Called once the jobs are accepted — NOT once they finish (that's /jobs). */
  onSuccess?: () => void;
  className?: string;
  buttonClassName?: string;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [cityCount, setCityCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { toasts, push, dismiss } = useToasts();

  const cityKey = scope === "city" ? `${city?.country ?? ""}|${city?.city ?? ""}` : "all";

  // One GET serves both shapes: it returns per-city counts, so the city
  // variant filters client-side rather than needing its own endpoint.
  useEffect(() => {
    let cancelled = false;
    if (scope === "city" && !city) return;
    (async () => {
      try {
        const res = await fetch("/api/ingest/repair");
        if (!res.ok) return; // a missing count just leaves the button unlabelled
        const j = (await res.json()) as {
          totalFlorists: number;
          cities: { country: string; city: string; florists: number }[];
        };
        if (cancelled) return;
        if (scope === "all") {
          setCount(j.totalFlorists);
          setCityCount(j.cities.length);
        } else {
          const match = j.cities.find(
            (c) =>
              c.country.toLowerCase() === city!.country.toLowerCase() &&
              c.city.toLowerCase() === city!.city.toLowerCase()
          );
          setCount(match?.florists ?? 0);
        }
      } catch {
        /* leave unlabelled — the button still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, cityKey, city]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ingest/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scope === "all" ? { scope: "all" } : { country: city!.country, city: city!.city }
        ),
      });
      const j = (await res.json().catch(() => ({}))) as {
        enqueued?: unknown[];
        skipped?: { reason: string }[];
        totalFlorists?: number;
        error?: string;
      };
      if (!res.ok) {
        push("error", j.error || `Request failed (${res.status}).`);
        return;
      }
      const n = j.enqueued?.length ?? 0;
      const skipped = j.skipped?.length ?? 0;
      push(
        "success",
        `Repairing ${j.totalFlorists ?? 0} florist(s) across ${n} ${n === 1 ? "city" : "cities"}` +
          (skipped > 0 ? ` · ${skipped} skipped` : "") +
          " — track progress on Ingest runs."
      );
      setCount(0);
      onSuccess?.();
    } catch (e) {
      push("error", e instanceof Error ? e.message : "Repair failed to start.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const nothingToDo = count === 0;
  const label =
    scope === "all"
      ? count == null
        ? "Repair enrichment"
        : `Repair enrichment (${count})`
      : count == null
        ? "Repair"
        : `Repair (${count})`;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy || nothingToDo || (scope === "city" && !city)}
        title={
          nothingToDo
            ? "Nothing to repair — every florist with a website already has an email"
            : "Re-run enrichment for florists whose last attempt failed. No scrape; Apify is not billed."
        }
        className={
          buttonClassName ??
          "rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft shadow-sm transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
        }
      >
        {busy ? "Starting…" : `✚ ${label}`}
      </button>

      {confirming && (
        <div
          className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirming(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Repair enrichment"
            className="w-full max-w-md rounded-lg bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-ink">
              {scope === "all"
                ? `Repair enrichment across ${cityCount ?? "all"} ${cityCount === 1 ? "city" : "cities"}?`
                : `Repair enrichment for ${city?.city}, ${city?.country}?`}
            </h2>
            <p className="mt-3 text-sm text-ink-soft">
              Re-runs enrichment for <strong>{count ?? "the"}</strong> florist(s) that have a website
              but no email, because the last attempt failed. Nothing is scraped and Apify is not
              billed. Existing values are never overwritten.
            </p>
            {scope === "all" && (
              <p className="mt-2 text-xs text-ink-faint">
                One job per city, so progress and cost are visible per city on Ingest runs. Expect
                roughly 15–20 seconds per florist.
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={run}
                disabled={busy}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:bg-accent-ink disabled:opacity-50"
              >
                {busy ? "Starting…" : "Repair"}
              </button>
            </div>
          </div>
        </div>
      )}

      <SimpleToast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
