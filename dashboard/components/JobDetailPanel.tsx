"use client";

// Per-run detail: non-modal right-side drawer opened by clicking a row in
// the /jobs history table. Mirrors the read-only, no-focus-trap treatment
// JobsPanel uses for its own drawer — this is inspection, not data entry.
// See docs/superpowers/plans/2026-07-02-jobs-cost-visualization.md Task 11.

import { totalCost, formatUsd } from "@/lib/cost";
import type { IngestJob, LlmTypeCost } from "@/lib/types";

export default function JobDetailPanel({
  job,
  onClose,
}: {
  job: IngestJob | null;
  onClose: () => void;
}) {
  if (!job) return null;
  const total = totalCost(job);
  const perFlorist = total != null && job.florist_count ? total / job.florist_count : null;
  const byType = job.llm_cost_by_type ?? {};
  const rows = Object.entries(byType) as [string, LlmTypeCost][];

  return (
    <aside
      role="region"
      aria-label={`Run detail for ${job.city}`}
      className="fixed inset-y-0 right-0 z-[1100] flex w-full max-w-md flex-col overflow-y-auto border-l border-line bg-surface p-5 shadow-2xl"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">
          {job.city}, {job.country}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md px-2 py-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft"
        >
          &times;
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-ink-soft">Total cost</dt>
        <dd className="text-right tabular-nums font-medium">{formatUsd(total)}</dd>
        <dt className="text-ink-soft">Per florist</dt>
        <dd className="text-right tabular-nums">
          {perFlorist != null ? `$${perFlorist.toFixed(4)}` : "—"}
        </dd>
        <dt className="text-ink-soft">Apify (actual)</dt>
        <dd className="text-right tabular-nums">{formatUsd(job.apify_cost_usd)}</dd>
        <dt className="text-ink-soft">LLM</dt>
        <dd className="text-right tabular-nums">{formatUsd(job.llm_cost_usd)}</dd>
      </dl>

      {rows.length > 0 && (
        <table className="mt-4 w-full text-xs">
          <caption className="sr-only">LLM cost by call type</caption>
          <thead className="text-left text-ink-soft">
            <tr>
              <th className="py-1">Type</th>
              <th className="py-1">Model</th>
              <th className="py-1 text-right">Calls</th>
              <th className="py-1 text-right">Tokens</th>
              <th className="py-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([type, c]) => (
              <tr key={type} className="border-t border-line">
                <td className="py-1 font-medium text-ink-soft">{type}</td>
                <td className="py-1 text-ink-soft">{c.model.replace("claude-", "")}</td>
                <td className="py-1 text-right tabular-nums">{c.calls}</td>
                <td className="py-1 text-right tabular-nums">
                  {(c.input_tokens + c.output_tokens).toLocaleString()}
                </td>
                <td className="py-1 text-right tabular-nums">{formatUsd(c.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {job.error && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-red-700">Error</h3>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-red-50 p-2 text-[11px] text-red-700">
            {job.error}
          </pre>
        </div>
      )}

      {job.log && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Log</h3>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px] text-ink-soft">
            {job.log}
          </pre>
        </div>
      )}
    </aside>
  );
}
