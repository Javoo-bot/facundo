"use client";

import { useRef, useState } from "react";
import RerunConfirmDialog from "@/components/RerunConfirmDialog";
import SimpleToast from "@/components/SimpleToast";
import { useToasts } from "@/lib/useToasts";
import type { City } from "@/lib/types";

// Re-run doesn't expose a limit control (unlike AddCityForm) — it's meant to
// be a quick "refresh this city with today's localized keywords" action, so
// it reuses AddCityForm's default per-keyword limit rather than asking the
// user to reconfigure it.
const RERUN_LIMIT = 40;
const FALLBACK_RADIUS_KM = 10;

// Queue mode (the Cloudflare deployment): POST /api/ingest enqueues a job for
// the Mac-mini poller, which derives localized keywords itself. So we skip the
// /api/keywords prefetch (it 503s on the deployment) and enqueue with null
// keywords. Unset (local dev) keeps the prefetch-then-spawn flow.
const INGEST_QUEUE_MODE = process.env.NEXT_PUBLIC_INGEST_MODE === "queue";

interface KeywordsCacheEntry {
  keywords: string[];
  language: string;
}

function extractErrorMessage(text: string, status: number): string {
  try {
    return (JSON.parse(text) as { error?: string }).error || text || `Request failed (${status}).`;
  } catch {
    return text || `Request failed (${status}).`;
  }
}

/**
 * Fire-and-forget re-run: fetches this city's localized keywords (cached
 * per-country in-session), POSTs /api/ingest, and — instead of streaming the
 * whole run inline like before — shows one optimistic "Re-running…" toast
 * and lets the jobs panel own progress/completion from there (see
 * docs/superpowers/specs/2026-07-02-background-jobs-design.md).
 */
export default function RerunCityButton({
  city,
  onRerunSuccess,
  className = "mt-2",
  buttonClassName,
  floristCount,
}: {
  /** The currently-selected, already-ingested city, or null if none is
   * selected. The button is disabled (with an explanatory title) when null. */
  city: City | null;
  /** Called once POST /api/ingest accepts the re-run request (not once the
   * ingest finishes — that's surfaced via the jobs panel). */
  onRerunSuccess: () => void;
  /** Wrapper className — defaults to the original sidebar spacing (`mt-2`).
   * Callers embedding this in a header row (e.g. DashboardClient) override
   * it to avoid an unwanted top offset. */
  className?: string;
  /** Button className override — callers embedding this as a compact header
   * action pass a narrower/ghost style instead of the sidebar's full-width
   * bordered button. */
  buttonClassName?: string;
  /** Current (unfiltered) florist count for this city — passed through to
   * the confirm dialog's "delete the N existing florists" copy. Optional;
   * the dialog falls back to a countless phrasing when omitted. */
  floristCount?: number | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Simple in-memory per-country cache — avoids re-fetching keywords on
  // repeated re-runs of the same city within a session. Not required by the
  // contract (the route itself is cache-first server-side too), but saves a
  // round trip client-side.
  const cacheRef = useRef<Map<string, KeywordsCacheEntry>>(new Map());
  const { toasts, push, dismiss } = useToasts();

  const runRerun = async (resetExisting: boolean) => {
    if (!city || busy) return;
    setBusy(true);
    setError(null);

    try {
      // In queue mode the Mac-mini CLI derives keywords, so leave them null and
      // skip the prefetch. In spawn mode, fetch (cached per-country) as before.
      let keywords: string[] | null = null;
      let language: string | null = null;

      if (!INGEST_QUEUE_MODE) {
        let kwData = cacheRef.current.get(city.country);
        if (!kwData) {
          const res = await fetch("/api/keywords", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ country: city.country }),
          });

          if (!res.ok) {
            const message = extractErrorMessage(await res.text().catch(() => ""), res.status);
            setError(message);
            push("error", message);
            return;
          }

          kwData = (await res.json()) as KeywordsCacheEntry;
          cacheRef.current.set(city.country, kwData);
        }
        keywords = kwData.keywords;
        language = kwData.language;
      }

      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: city.country,
          city: city.city,
          radius: city.radius_km ?? FALLBACK_RADIUS_KM,
          limit: RERUN_LIMIT,
          keywords,
          language,
          resetExisting,
        }),
      });

      if (!res.ok) {
        const message = extractErrorMessage(await res.text().catch(() => ""), res.status);
        setError(message);
        push("error", message);
        return;
      }

      push("success", `Re-running ${city.city}, ${city.country}… track progress in the jobs panel.`);
      onRerunSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Re-run failed to start.";
      setError(message);
      push("error", message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => {
          if (city && !busy) setConfirming(true);
        }}
        disabled={!city || busy}
        title={city ? "Re-run ingest for this city with fresh localized keywords" : "Select a city first"}
        className={
          buttonClassName ??
          "w-full rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft shadow-sm transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
        }
      >
        {busy ? "Starting…" : "↻ Re-run"}
      </button>

      {error && <p className="mt-2 text-xs text-crit">{error}</p>}

      {confirming && city && (
        <RerunConfirmDialog
          city={city}
          floristCount={floristCount ?? null}
          onConfirm={(resetExisting) => {
            setConfirming(false);
            runRerun(resetExisting);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}

      <SimpleToast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
