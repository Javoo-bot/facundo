"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { score, scoreBreakdown } from "@/lib/scoring";
import type { Florist, Outreach, Weights } from "@/lib/types";

const COPIED_LABEL_DURATION_MS = 1500;
const DESKTOP_QUERY = "(min-width: 1024px)";

const LABELS: Record<keyof ReturnType<typeof scoreBreakdown>, string> = {
  rating: "Rating",
  reviews: "Reviews",
  website: "Website",
  ecommerce: "Ecommerce",
  distance: "Distance penalty",
};

function subscribeToDesktopQuery(callback: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getIsDesktopSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function getIsDesktopServerSnapshot(): boolean {
  // Modal-semantics superset (role="dialog"/aria-modal="true"/focus-trap) so
  // server-rendered markup is deterministic without access to the viewport.
  return false;
}

// Same shape as /api/ingest's error body (see RerunCityButton.tsx /
// CitiesTable.tsx) — /api/florists/exclude's jsonError() returns
// `{ error: string }` JSON, not plain text, so parse it rather than showing
// the raw JSON string to the user.
function extractErrorMessage(text: string, status: number): string {
  try {
    return (JSON.parse(text) as { error?: string }).error || text || `Request failed (${status}).`;
  } catch {
    return text || `Request failed (${status}).`;
  }
}

/**
 * Tracks the `(min-width: 1024px)` breakpoint via `useSyncExternalStore`
 * rather than `useState` + `useEffect`. This matters: a manual
 * `useState(false)` seeded by an effect is stale for the *entire* first
 * commit, including every other effect registered in that same commit (React
 * flushes an update scheduled inside an effect only in a follow-up render —
 * it does not retroactively fix the closures effects in the current commit
 * already captured). That previously meant the focus-trap effect below ran
 * with `isDesktop === false` on first mount even on a desktop viewport,
 * unconditionally yanking focus to the close button before the "real" value
 * arrived a tick later — exactly the modal-style focus steal the non-modal
 * desktop treatment is supposed to avoid. `useSyncExternalStore` reads the
 * live snapshot synchronously during render (forcing a re-render before
 * commit if hydration under-guessed), so every effect in the mount commit
 * already sees the correct value.
 */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeToDesktopQuery,
    getIsDesktopSnapshot,
    getIsDesktopServerSnapshot
  );
}

/**
 * Fix (current-code defect #3): this used to be a full-screen dimmed modal
 * that blocked the map/table underneath. It's now a docked side panel:
 *  - ≥1024px: non-modal (`role="region"`) — the map/table stay clickable,
 *    focus is never stolen from whatever the analyst was doing, and an
 *    `aria-live` note announces which florist the panel now shows.
 *  - <1024px: modal fallback (`role="dialog" aria-modal="true"`) with a
 *    backdrop, an on-open focus move, and a Tab-cycle trap — there's no room
 *    to keep the map/table interactive underneath a full-width panel.
 * The `lg:hidden` backdrop is CSS-only (not gated on the JS `isDesktop`
 * flag) so there's no one-frame flash of a backdrop on desktop before the
 * media-query effect runs.
 */
export default function ScoreBreakdown({
  florist,
  weights,
  outreach,
  onClose,
  onExcluded,
}: {
  florist: Florist;
  weights: Weights;
  /** This florist's outreach log, most-recent first — see DashboardClient's
   * `outreach.filter((o) => o.florist_id === selectedFlorist.id)`. */
  outreach?: Outreach[];
  onClose: () => void;
  onExcluded?: () => void;
}) {
  const isDesktop = useIsDesktop();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const breakdown = scoreBreakdown(florist, weights);
  const total = score(florist, weights);
  const maxAbs = Math.max(1e-6, ...Object.values(breakdown).map((v) => Math.abs(v)));

  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [excluding, setExcluding] = useState(false);
  const [excludeError, setExcludeError] = useState<string | null>(null);

  // Reset the "Copied!" state (and any pending timeout) whenever a different
  // florist is selected — this component instance persists across
  // selections since DashboardClient doesn't key it by florist id.
  useEffect(() => {
    setCopied(false);
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, [florist.id]);

  // Escape closes in both modal and non-modal modes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Focus management, mobile-modal only: on desktop this panel is
  // non-blocking and ambient, so forcibly moving focus every time a row or
  // pin is clicked would fight the table/map's own keyboard flow. Below
  // 1024px it behaves as a true modal, so it gets the standard treatment —
  // focus the close button on open, and trap Tab inside the panel.
  useEffect(() => {
    if (isDesktop) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isDesktop, florist.id]);

  const handleCopyDraft = async () => {
    if (!florist.drafted_email) return;
    try {
      await navigator.clipboard.writeText(florist.drafted_email);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), COPIED_LABEL_DURATION_MS);
    } catch {
      // Clipboard API unavailable or permission denied — POC scope, no
      // fallback UI needed; the text is still visible to copy manually.
    }
  };

  const handleExclude = async () => {
    setExcluding(true);
    setExcludeError(null);
    try {
      const res = await fetch("/api/florists/exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floristId: florist.id }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setExcludeError(extractErrorMessage(text, res.status));
        return;
      }
      onExcluded?.();
    } catch (e) {
      setExcludeError(e instanceof Error ? e.message : "Exclude failed.");
    } finally {
      setExcluding(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[999] animate-overview-backdrop-fade bg-black/20 lg:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role={isDesktop ? "region" : "dialog"}
        aria-modal={isDesktop ? undefined : true}
        aria-label={`Score breakdown for ${florist.name}`}
        className="fixed inset-y-0 right-0 z-[1000] flex w-full max-w-sm animate-city-panel-slide-in flex-col overflow-y-auto border-l border-line bg-surface p-6 shadow-2xl motion-reduce:animate-none"
      >
        <p aria-live="polite" className="sr-only">
          Showing score breakdown for {florist.name}
        </p>

        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-ink">{florist.name}</h2>
            <p className="text-sm text-ink-soft">Score breakdown</p>
            <Link
              href={`/florists/${florist.id}`}
              className="mt-1 inline-block text-sm font-medium text-accent hover:text-accent-ink hover:underline"
            >
              Open full card →
            </Link>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close score breakdown"
            className="rounded-md px-2 py-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft"
          >
            &times;
          </button>
        </div>

        <p className="mt-4 text-sm text-ink-soft">
          Total score:{" "}
          <span className="font-mono font-semibold tabular-nums text-ink">
            {total.toFixed(2)}
          </span>
        </p>

        <div className="mt-4 space-y-4">
          {(Object.keys(breakdown) as Array<keyof typeof breakdown>).map((key) => {
            const value = breakdown[key];
            const widthPct = (Math.abs(value) / maxAbs) * 100;
            const isPositive = value >= 0;
            return (
              <div key={key}>
                <div className="flex items-center justify-between text-xs text-ink-soft">
                  <span>{LABELS[key]}</span>
                  <span className="font-mono tabular-nums">{value.toFixed(2)}</span>
                </div>
                <div className="mt-1 flex h-2.5 w-full rounded-full bg-surface-2">
                  <div
                    className={`h-2.5 rounded-full ${isPositive ? "bg-accent" : "bg-crit"}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <dl className="mt-6 space-y-1.5 border-t border-line pt-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-soft">Rating</dt>
            <dd className="tabular-nums">{florist.rating ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-soft">Reviews</dt>
            <dd className="tabular-nums">{florist.review_count ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-soft">Has website</dt>
            <dd>{florist.has_website ? "Yes" : "No"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-soft">Ecommerce</dt>
            <dd>{florist.is_ecommerce === null ? "Unknown" : florist.is_ecommerce ? "Yes" : "No"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-soft">Distance from center</dt>
            <dd className="tabular-nums">
              {florist.distance_km_from_center != null
                ? `${florist.distance_km_from_center.toFixed(2)} km`
                : "—"}
            </dd>
          </div>
          {florist.email && (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">Email</dt>
              <dd className="truncate">
                <a href={`mailto:${florist.email}`} className="text-accent hover:underline">
                  {florist.email}
                </a>
              </dd>
            </div>
          )}
          {(florist.phone_web ?? florist.phone_maps) && (
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">Phone</dt>
              <dd>
                <a
                  href={`tel:${florist.phone_web ?? florist.phone_maps}`}
                  className="text-accent hover:underline"
                >
                  {florist.phone_web ?? florist.phone_maps}
                </a>
              </dd>
            </div>
          )}
        </dl>

        <div className="mt-6 border-t border-line pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
              Outreach draft
            </h3>
            {florist.drafted_email && (
              <button
                type="button"
                onClick={handleCopyDraft}
                className="rounded-md border border-line-strong bg-surface px-2 py-0.5 text-xs font-medium text-ink-soft hover:bg-surface-2"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            )}
          </div>
          {florist.drafted_email ? (
            <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-3 font-mono text-xs text-ink-soft">
              {florist.drafted_email}
            </pre>
          ) : (
            <p className="mt-2 text-sm text-ink-faint">No draft (no email found)</p>
          )}
        </div>

        {outreach && outreach.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
              Outreach
            </h3>
            <ul className="mt-2 space-y-1.5">
              {outreach.map((o) => (
                <li key={o.id} className="text-xs text-ink-soft">
                  <span className={o.status === "sent" ? "text-accent" : "text-crit"}>
                    {o.status === "sent" ? "✓" : "✗"}
                  </span>{" "}
                  {new Date(o.sent_at).toLocaleDateString()} · {o.test_mode ? "test → " : "→ "}
                  {o.to_address ?? "—"}
                  {o.status === "failed" && o.error ? ` · ${o.error}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 border-t border-line pt-4">
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="text-xs font-medium text-crit hover:opacity-80"
            >
              Exclude this florist
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-ink-soft">
                Permanently exclude <span className="font-medium">{florist.name}</span>? It&apos;s
                hidden and skipped on every future scrape (recover via SQL).
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleExclude}
                  disabled={excluding}
                  className="rounded-md bg-crit px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {excluding ? "Excluding…" : "Confirm exclude"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={excluding}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-surface-2"
                >
                  Cancel
                </button>
              </div>
              {excludeError && <p className="text-xs text-crit">{excludeError}</p>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
