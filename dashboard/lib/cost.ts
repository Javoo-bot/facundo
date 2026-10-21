// Cost + duration helpers for ingest_jobs (workstream A). Cost columns are
// nullable (null while a job is running, or for rows ingested before this
// shipped) — every helper here is null-guarded so a partial row renders "—"
// rather than "$0.00" or NaN. See docs/superpowers/plans/
// 2026-07-02-jobs-cost-visualization.md.

import type { IngestJob } from "@/lib/types";

/** Sum of the two cost components; null only when BOTH are null. */
export function totalCost(
  job: Pick<IngestJob, "llm_cost_usd" | "apify_cost_usd">,
): number | null {
  const { llm_cost_usd: llm, apify_cost_usd: apify } = job;
  if (llm == null && apify == null) return null;
  // Round off binary floating-point noise (e.g. 0.4 + 0.02 = 0.42000000000000004)
  // — costs are USD to the cent/sub-cent, not exact binary fractions.
  return Math.round(((llm ?? 0) + (apify ?? 0)) * 1e6) / 1e6;
}

export function formatUsd(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

export function durationMs(
  job: Pick<IngestJob, "started_at" | "finished_at">,
): number | null {
  if (!job.finished_at) return null;
  return new Date(job.finished_at).getTime() - new Date(job.started_at).getTime();
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
