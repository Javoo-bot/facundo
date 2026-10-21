"use client";

// /jobs history page: full ingest run history with per-run cost + timing, a
// stacked cost chart, and a click-through detail drawer. See
// docs/superpowers/plans/2026-07-02-jobs-cost-visualization.md Tasks 10-11.

import { useState } from "react";
import JobDetailPanel from "@/components/JobDetailPanel";
import JobsCostChart from "@/components/JobsCostChart";
import { IconCheckCircle, IconClock, IconSpinner, IconXCircle } from "@/components/icons";
import { totalCost, formatUsd, durationMs, formatDuration } from "@/lib/cost";
import type { IngestJob } from "@/lib/types";

function StatusBadge({ status }: { status: IngestJob["status"] }) {
  if (status === "queued") {
    return <IconClock className="h-4 w-4 text-warn" />;
  }
  if (status === "running") {
    return <IconSpinner className="h-4 w-4 animate-spin text-accent" />;
  }
  if (status === "succeeded") {
    return <IconCheckCircle className="h-4 w-4 text-accent" />;
  }
  return <IconXCircle className="h-4 w-4 text-crit" />;
}

export default function JobsHistoryClient({ jobs }: { jobs: IngestJob[] }) {
  const [selected, setSelected] = useState<IngestJob | null>(null);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <p className="eyebrow">Backoffice</p>
      <h1>Ingest runs</h1>
      <div className="mt-6">
        <JobsCostChart jobs={jobs} />

        {jobs.length === 0 ? (
          <p className="mt-8 text-sm text-ink-faint">No ingest runs yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-sm">
              <caption className="sr-only">Ingest runs, most recent first</caption>
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-soft">
                <tr>
                  <th scope="col" className="px-4 py-2.5">
                    Run
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Started
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    Duration
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    Florists
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    Total
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    Apify
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    LLM
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    Tokens (in/out)
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    onClick={() => setSelected(job)}
                    className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2"
                  >
                    <td className="px-4 py-2.5 font-medium text-ink">
                      {job.city}, {job.country}
                      {/* A repair costs nothing on Apify and touches only rows
                          already stored, so a run showing 0 scraped and no
                          Apify spend is expected rather than a failure. */}
                      {job.mode === "repair" && (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-soft">
                          repair
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-soft">
                      {new Date(job.started_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatDuration(durationMs(job))}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {job.florist_count ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {formatUsd(totalCost(job))}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                      {formatUsd(job.apify_cost_usd)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                      {formatUsd(job.llm_cost_usd)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                      {job.input_tokens != null ? job.input_tokens.toLocaleString() : "—"}/
                      {job.output_tokens != null ? job.output_tokens.toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <JobDetailPanel job={selected} onClose={() => setSelected(null)} />
      </div>
    </div>
  );
}
