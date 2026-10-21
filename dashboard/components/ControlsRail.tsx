"use client";

import { useState } from "react";
import SliderPanel from "@/components/SliderPanel";
import { IconChevronRight } from "@/components/icons";
import { DEFAULT_SELECTION, DEFAULT_WEIGHTS } from "@/lib/scoring";
import type { Florist, SelectionParams, Weights } from "@/lib/types";

function countNonDefault(weights: Weights, selection: SelectionParams): number {
  let count = 0;
  (Object.keys(DEFAULT_WEIGHTS) as (keyof Weights)[]).forEach((key) => {
    if (weights[key] !== DEFAULT_WEIGHTS[key]) count += 1;
  });
  (Object.keys(DEFAULT_SELECTION) as (keyof SelectionParams)[]).forEach((key) => {
    if (selection[key] !== DEFAULT_SELECTION[key]) count += 1;
  });
  return count;
}

function ChangedBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      aria-hidden="true"
      className="flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-white"
    >
      {count}
    </span>
  );
}

/**
 * Collapse chrome around SliderPanel. Two independent renderings sharing one
 * component (CSS-breakpoint-switched, not JS-detected, so there's no
 * hydration-mismatch risk from guessing viewport width during SSR):
 *  - ≥1024px: a collapsible 300px↔48px rail (own `collapsed` state, default
 *    expanded — the brief's "auto-collapse at 1024–1279px" nuance is judged
 *    a non-essential polish item and left to the user's manual toggle; see
 *    the frontend hand-off notes).
 *  - <1024px: a native `<details>` full-width disclosure, open by default,
 *    with SliderPanel's three sections tiled 2-up via `className`.
 * Both show a badge of how many sliders differ from the defaults.
 */
export default function ControlsRail({
  weights,
  onWeightsChange,
  selection,
  onSelectionChange,
  targetFlorist,
  targetLabel,
}: {
  weights: Weights;
  onWeightsChange: (weights: Weights) => void;
  selection: SelectionParams;
  onSelectionChange: (selection: SelectionParams) => void;
  targetFlorist: Florist | null;
  targetLabel: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const nonDefaultCount = countNonDefault(weights, selection);

  const sliderPanel = (className?: string) => (
    <SliderPanel
      weights={weights}
      onWeightsChange={onWeightsChange}
      selection={selection}
      onSelectionChange={onSelectionChange}
      targetFlorist={targetFlorist}
      targetLabel={targetLabel}
      className={className}
    />
  );

  // Single root element (not a Fragment) so this is exactly one grid item in
  // DashboardClient's `lg:grid-cols-[auto_1fr]` layout regardless of which
  // breakpoint is active — a Fragment with two top-level siblings here would
  // each become their own grid item and scramble the column placement. The
  // width classes live on this wrapper itself: at <1024px it has no width
  // class (stretches to the grid's single column, full width, for the
  // `<details>` fallback); at ≥1024px an explicit `lg:w-12`/`lg:w-[300px]`
  // overrides the grid's default item-stretch for the rail.
  return (
    <div
      className={`min-h-0 transition-[width] duration-200 motion-reduce:transition-none ${
        collapsed ? "lg:w-12" : "lg:w-[300px]"
      }`}
    >
      <div className="hidden h-full min-h-0 lg:block">
        {collapsed ? (
          <div className="flex h-full flex-col items-center gap-2 rounded-lg border border-line bg-surface py-3 shadow-sm">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              aria-label={`Expand controls${nonDefaultCount > 0 ? ` — ${nonDefaultCount} changed from defaults` : ""}`}
              title="Expand controls"
              className="relative rounded-md p-1.5 text-ink-soft hover:bg-surface-2 hover:text-ink"
            >
              <IconChevronRight className="h-4 w-4" />
              <span className="absolute -right-1 -top-1">
                <ChangedBadge count={nonDefaultCount} />
              </span>
            </button>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-y-auto rounded-lg border border-line bg-surface p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">Controls</h2>
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse controls"
                title="Collapse controls"
                className="rounded-md p-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft"
              >
                <IconChevronRight className="h-4 w-4 rotate-180" />
              </button>
            </div>
            {sliderPanel()}
          </div>
        )}
      </div>

      <details className="rounded-lg border border-line bg-surface p-4 shadow-sm lg:hidden" open>
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-ink">
          Controls
          <ChangedBadge count={nonDefaultCount} />
        </summary>
        <div className="mt-3">{sliderPanel("grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2")}</div>
      </details>
    </div>
  );
}
