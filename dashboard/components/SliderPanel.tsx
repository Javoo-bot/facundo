"use client";

import { useState } from "react";
import type { Florist, SelectionParams, Weights } from "@/lib/types";
import { DEFAULT_SELECTION, DEFAULT_WEIGHTS, scoreBreakdown } from "@/lib/scoring";

/** Info expander next to the Weights heading. Explains the formula in
 * lib/scoring.ts in plain language — same content as docs/methodology.md's
 * "How scoring works" section. */
function HowScoringWorks() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs font-medium text-accent underline decoration-dotted underline-offset-2 hover:text-accent-ink"
      >
        {open ? "Hide" : "How scoring works"}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-line bg-surface-2 p-2.5 text-xs leading-relaxed text-ink-soft">
          <p className="whitespace-pre-wrap break-words font-mono text-[11px] text-ink-soft">
            {"score = w.rating·(rating−3.0)\n" +
              "      + w.reviews·log10(reviews+1)\n" +
              "      + w.website·(has_website?1:0)\n" +
              "      + w.ecommerce·(is_ecommerce?1:0)\n" +
              "      − w.distance·distance_km"}
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>3★ is the neutral baseline — ratings below 3 subtract, above 3 add.</li>
            <li>
              <code className="rounded bg-surface px-1 py-0.5">log10</code> dampens review
              count so 500 reviews isn&apos;t worth 10× what 50 reviews is worth.
            </li>
            <li>Distance is subtracted — farther from the city center scores lower.</li>
            <li>
              Each weight scales its term&apos;s contribution; the two filter sliders
              (min rating, min reviews) exclude florists entirely rather than scoring
              them down.
            </li>
          </ul>
          <p className="border-t border-line pt-2 font-medium text-ink-soft">
            Weights and scores are live and client-side only — they are not saved.
            Reloading the page resets everything to the defaults above.
          </p>
        </div>
      )}
    </div>
  );
}

/** Mini contribution bar under a weight slider — emerald for a positive
 * contribution to the target florist's score, red for negative, scaled
 * against the largest |contribution| across all five weight terms so the
 * bars are comparable to each other at a glance. */
function ContributionBar({ value, maxAbs }: { value: number; maxAbs: number }) {
  const widthPct = maxAbs > 0 ? Math.min(100, (Math.abs(value) / maxAbs) * 100) : 0;
  const isPositive = value >= 0;
  return (
    <div
      className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
      role="img"
      aria-label={`Contributes ${value >= 0 ? "+" : ""}${value.toFixed(2)} to the score`}
    >
      <div
        className={`h-full rounded-full ${isPositive ? "bg-accent" : "bg-crit"}`}
        style={{ width: `${widthPct}%` }}
      />
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  contribution,
  maxAbsContribution,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  /** When provided (weight sliders with a target florist selected), renders
   * a mini bar showing that weight's live contribution to the target
   * florist's score. */
  contribution?: number;
  maxAbsContribution?: number;
}) {
  const format = formatValue ?? ((v: number) => String(v));
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs text-ink-soft">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-ink">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--accent)]"
      />
      {/* Fix (brief item #10): min/max bounds were previously unlabeled. */}
      <span className="flex items-center justify-between text-[10px] tabular-nums text-ink-faint">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </span>
      {contribution != null && maxAbsContribution != null && (
        <ContributionBar value={contribution} maxAbs={maxAbsContribution} />
      )}
    </label>
  );
}

export default function SliderPanel({
  weights,
  onWeightsChange,
  selection,
  onSelectionChange,
  targetFlorist,
  targetLabel,
  className,
}: {
  weights: Weights;
  onWeightsChange: (weights: Weights) => void;
  selection: SelectionParams;
  onSelectionChange: (selection: SelectionParams) => void;
  /** The florist the weight-contribution bars are computed against —
   * ambient (not a CTA): the selected florist if one is open, else rank #1
   * of the current sort. Null only when there are zero florists to target. */
  targetFlorist?: Florist | null;
  /** Display name for the "Weights — effect on {name}" section label;
   * undefined falls back to the plain "Weights" label. */
  targetLabel?: string | null;
  /** Root wrapper layout — defaults to a single vertical stack (the
   * collapsible desktop rail); ControlsRail's <1024px disclosure passes a
   * 2-column grid instead ("full-width disclosure (2-col sections)" per the
   * brief's Responsive section). */
  className?: string;
}) {
  const setWeight = (key: keyof Weights, value: number) => {
    onWeightsChange({ ...weights, [key]: value });
  };
  const setSelection = (key: keyof SelectionParams, value: number) => {
    onSelectionChange({ ...selection, [key]: value });
  };

  const reset = () => {
    onWeightsChange(DEFAULT_WEIGHTS);
    onSelectionChange(DEFAULT_SELECTION);
  };

  const breakdown = targetFlorist ? scoreBreakdown(targetFlorist, weights) : null;
  const maxAbsContribution = breakdown
    ? Math.max(1e-6, ...Object.values(breakdown).map((v) => Math.abs(v)))
    : undefined;

  return (
    <div className={className ?? "space-y-6"}>
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Filters
        </h2>
        <div className="mt-2 space-y-3">
          <Slider
            label="Min rating"
            value={weights.minRating}
            min={3.0}
            max={5.0}
            step={0.1}
            onChange={(v) => setWeight("minRating", v)}
            formatValue={(v) => v.toFixed(1)}
          />
          <Slider
            label="Min reviews"
            value={weights.minReviews}
            min={0}
            max={500}
            step={5}
            onChange={(v) => setWeight("minReviews", v)}
          />
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          {targetLabel ? (
            <>
              Weights <span className="normal-case text-ink-faint">— effect on {targetLabel}</span>
            </>
          ) : (
            "Weights"
          )}
        </h2>
        <HowScoringWorks />
        <div className="mt-2 space-y-3">
          <Slider
            label="Rating"
            value={weights.rating}
            min={0}
            max={2}
            step={0.1}
            onChange={(v) => setWeight("rating", v)}
            formatValue={(v) => v.toFixed(1)}
            contribution={breakdown?.rating}
            maxAbsContribution={maxAbsContribution}
          />
          <Slider
            label="Reviews"
            value={weights.reviews}
            min={0}
            max={2}
            step={0.1}
            onChange={(v) => setWeight("reviews", v)}
            formatValue={(v) => v.toFixed(1)}
            contribution={breakdown?.reviews}
            maxAbsContribution={maxAbsContribution}
          />
          <Slider
            label="Website"
            value={weights.website}
            min={0}
            max={2}
            step={0.1}
            onChange={(v) => setWeight("website", v)}
            formatValue={(v) => v.toFixed(1)}
            contribution={breakdown?.website}
            maxAbsContribution={maxAbsContribution}
          />
          <Slider
            label="Ecommerce"
            value={weights.ecommerce}
            min={0}
            max={2}
            step={0.1}
            onChange={(v) => setWeight("ecommerce", v)}
            formatValue={(v) => v.toFixed(1)}
            contribution={breakdown?.ecommerce}
            maxAbsContribution={maxAbsContribution}
          />
          <Slider
            label="Distance penalty"
            value={weights.distance}
            min={0}
            max={2}
            step={0.1}
            onChange={(v) => setWeight("distance", v)}
            formatValue={(v) => v.toFixed(1)}
            contribution={breakdown?.distance}
            maxAbsContribution={maxAbsContribution}
          />
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Selection
        </h2>
        <div className="mt-2 space-y-3">
          <Slider
            label="Top K"
            value={selection.topK}
            min={1}
            max={20}
            step={1}
            onChange={(v) => setSelection("topK", v)}
          />
          <Slider
            label="Min separation (m)"
            value={selection.minSeparationMeters}
            min={0}
            max={2000}
            step={100}
            onChange={(v) => setSelection("minSeparationMeters", v)}
          />
        </div>
      </section>

      <button
        type="button"
        onClick={reset}
        className="w-full rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft shadow-sm transition hover:bg-surface-2 sm:col-span-full"
      >
        Reset to defaults
      </button>
    </div>
  );
}
