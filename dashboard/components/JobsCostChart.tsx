"use client";

// Stacked cost bar chart for the /jobs history page — one bar per run,
// oldest -> newest left to right, height proportional to total cost.
// Inline SVG/DOM only (no chart library — CSP-safe, matches the existing
// icon convention). Emerald = Apify (actual usage_total_usd), indigo = LLM
// (exact tokens x per-model rate). See docs/superpowers/plans/
// 2026-07-02-jobs-cost-visualization.md Task 11.

import { totalCost, formatUsd } from "@/lib/cost";
import type { IngestJob } from "@/lib/types";

const H = 120; // chart height in px

export default function JobsCostChart({ jobs }: { jobs: IngestJob[] }) {
  const data = [...jobs].reverse(); // oldest first
  const max = Math.max(0.0001, ...data.map((j) => totalCost(j) ?? 0));
  if (data.every((j) => totalCost(j) == null)) return null;

  return (
    <figure className="rounded-lg border border-line bg-surface p-4">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-soft">
        <span className="font-medium text-ink">Cost per run</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: "var(--accent)" }} />
            Apify (actual)
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: "var(--bloom)" }} />
            LLM (Sonnet-5 rates)
          </span>
        </span>
      </figcaption>
      <div className="mt-3 flex items-end gap-2" style={{ height: H }}>
        {data.map((j) => {
          const total = totalCost(j);
          if (total == null) {
            // No cost recorded (running, or a pre-cost-tracking row) — a
            // muted baseline tick rather than a misleading zero-height bar.
            return (
              <div
                key={j.id}
                className="group relative flex flex-1 flex-col items-center justify-end"
                title={`${j.city}: cost unavailable`}
              >
                <div className="h-1 w-full max-w-[36px] rounded-t bg-line-strong" />
                <span className="mt-1 w-full truncate text-center text-[10px] text-ink-faint">
                  {j.city}
                </span>
              </div>
            );
          }
          const apify = j.apify_cost_usd ?? 0;
          const llm = j.llm_cost_usd ?? 0;
          const apifyH = (apify / max) * H;
          const llmH = (llm / max) * H;
          return (
            <div
              key={j.id}
              className="group relative flex flex-1 flex-col items-center justify-end"
              title={`${j.city}: ${formatUsd(total)}`}
            >
              <div className="flex w-full max-w-[36px] flex-col justify-end overflow-hidden rounded-t">
                <div style={{ height: llmH, background: "var(--bloom)" }} />
                <div style={{ height: apifyH, background: "var(--accent)" }} />
              </div>
              <span className="mt-1 w-full truncate text-center text-[10px] text-ink-faint">
                {j.city}
              </span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
