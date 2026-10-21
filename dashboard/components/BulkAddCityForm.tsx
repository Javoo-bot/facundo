"use client";

import { useState } from "react";
import { parseCityList } from "@/lib/cityList";

const DEFAULT_RADIUS_KM = 10;
// Places to scrape PER CITY, across all keywords. Apify bills per place
// (~$0.004), and ~58% survive the relevance filter, so 25 costs ~$0.10 and
// yields ~15 shops. This used to be 40 and to mean per-KEYWORD: with Spain's
// eight keywords that scraped 285 places and cost $1.14 a city.
const DEFAULT_LIMIT = 25;
/** Measured 2026-09-09 across three Apify runs (279->$1.12, 285/285->$1.14). */
const USD_PER_PLACE = 0.004;

const inputClasses =
  "mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-[var(--accent)] disabled:bg-surface-2";
const primaryButtonClasses =
  "rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-line-strong";

/**
 * Paste-a-list ingest: one "Country, City" per line, shared radius/limit for
 * the whole batch. Localized keywords are derived per-country by the pipeline,
 * so there's no keyword step here (unlike the single-city AddCityForm wizard).
 * Posts { cities, radius, limit } to the /api/ingest batch path.
 */
export default function BulkAddCityForm({
  onRunningChange,
  onBatchSuccess,
}: {
  onRunningChange?: (running: boolean) => void;
  onBatchSuccess: (summary: { enqueued: number; skipped: number }) => void;
}) {
  const [text, setText] = useState("");
  const [radius, setRadius] = useState(DEFAULT_RADIUS_KM);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { cities, errors } = parseCityList(text);

  const submit = async () => {
    if (submitting || cities.length === 0) return;
    setError(null);
    setSubmitting(true);
    onRunningChange?.(true);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cities, radius, limit }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        enqueued?: unknown[];
        skipped?: unknown[];
        error?: string;
      };
      if (!res.ok) {
        setError(j.error || `Request failed (${res.status}).`);
        return;
      }
      onBatchSuccess({ enqueued: j.enqueued?.length ?? 0, skipped: j.skipped?.length ?? 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start ingest.");
    } finally {
      setSubmitting(false);
      onRunningChange?.(false);
    }
  };

  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium text-ink-soft">
        Cities — one per line, <span className="text-ink-soft">Country, City</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={submitting}
          rows={6}
          placeholder={"ES, Barcelona\nES, Girona\nFR, Lyon\nUS, Boston"}
          className={`${inputClasses} font-mono`}
        />
      </label>

      <div className="flex gap-3">
        <label className="flex-1 text-sm font-medium text-ink-soft">
          Radius (km)
          <input
            type="number"
            value={radius}
            min={0.5}
            max={50}
            step={0.5}
            onChange={(e) => setRadius(Number(e.target.value))}
            disabled={submitting}
            className={inputClasses}
          />
        </label>
        <label className="flex-1 text-sm font-medium text-ink-soft">
          Max places per city
          <input
            type="number"
            value={limit}
            min={1}
            max={200}
            step={1}
            onChange={(e) => setLimit(Number(e.target.value))}
            disabled={submitting}
            className={inputClasses}
          />
        </label>
      </div>

      {cities.length > 0 && (
        <p className="text-xs text-ink-soft">
          Up to {cities.length * limit} places ≈{" "}
          <strong>${(cities.length * limit * USD_PER_PLACE).toFixed(2)}</strong> on Apify,
          for roughly {Math.round(cities.length * limit * 0.58)} florists.
        </p>
      )}

      <p className="text-xs text-ink-soft">
        {cities.length} valid {cities.length === 1 ? "city" : "cities"}
        {errors.length > 0 && (
          <span className="text-crit"> · {errors.length} line(s) ignored</span>
        )}
        . Localized keywords are derived per country automatically.
      </p>
      {errors.length > 0 && (
        <ul
          className="max-h-24 overflow-y-auto rounded border p-2 text-xs text-crit"
          style={{
            borderColor: "color-mix(in srgb, var(--crit) 35%, var(--line))",
            background: "color-mix(in srgb, var(--crit) 8%, transparent)",
          }}
        >
          {errors.map((e, i) => (
            <li key={i}>
              “{e.line}” — {e.reason}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-xs text-crit">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting || cities.length === 0}
        className={`w-full ${primaryButtonClasses}`}
      >
        {submitting ? "Starting…" : `Ingest ${cities.length || ""}`.trim()}
      </button>
    </div>
  );
}
