// Best-effort ingest_jobs tracking. Port of ingest/jobs.py. Every write is
// wrapped so a job-tracking failure never aborts the actual ingest.
import type { SupabaseClient } from "@supabase/supabase-js";
import { JOB_LOG_MAX_LINES, STALE_RUNNING_JOB_HOURS } from "./config";
import type { UsageTracker } from "./usage";

/** Append `line` to `existingLog`, keeping only the last `maxLines` lines.
 * Pure helper (no DB) so it's unit-testable. */
export function appendBoundedLog(
  existingLog: string | null,
  line: string,
  maxLines: number = JOB_LOG_MAX_LINES
): string {
  const lines = existingLog ? existingLog.split("\n") : [];
  lines.push(line);
  return lines.slice(-maxLines).join("\n");
}

export async function updateJobProgress(sb: SupabaseClient, jobId: string, line: string): Promise<void> {
  try {
    const { data } = await sb.from("ingest_jobs").select("log").eq("id", jobId).limit(1);
    const existingLog = data && data.length > 0 ? (data[0].log as string | null) : null;
    const newLog = appendBoundedLog(existingLog, line);
    await sb.from("ingest_jobs").update({ last_line: line, log: newLog }).eq("id", jobId);
  } catch (e) {
    console.warn(`Warning: failed to update job progress for ${jobId}: ${String(e)}`);
  }
}

export async function finishJob(
  sb: SupabaseClient,
  jobId: string,
  status: "succeeded" | "failed",
  opts: {
    error?: string | null;
    usage?: UsageTracker | null;
    apifyCostUsd?: number | null;
    floristCount?: number | null;
  } = {}
): Promise<void> {
  try {
    const update: Record<string, unknown> = {
      status,
      finished_at: new Date().toISOString(),
    };
    if (opts.error != null) update.error = opts.error;
    if (opts.usage) {
      update.input_tokens = opts.usage.totalInputTokens;
      update.output_tokens = opts.usage.totalOutputTokens;
      update.llm_calls = opts.usage.totalCalls;
      update.llm_cost_usd = Math.round(opts.usage.costUsd * 1e6) / 1e6;
      update.llm_cost_by_type = opts.usage.toByTypeDict();
    }
    if (opts.apifyCostUsd != null) update.apify_cost_usd = opts.apifyCostUsd;
    if (opts.floristCount != null) update.florist_count = opts.floristCount;
    await sb.from("ingest_jobs").update(update).eq("id", jobId);
  } catch (e) {
    console.warn(`Warning: failed to finish job ${jobId}: ${String(e)}`);
  }
}

/** The cutoff a `running` job must predate to count as dead. Pure so the
 *  threshold is testable without a clock or a database. */
export function staleRunningCutoffIso(nowMs: number, hours: number = STALE_RUNNING_JOB_HOURS): string {
  return new Date(nowMs - hours * 3600_000).toISOString();
}

/**
 * Mark long-dead `running` jobs as failed. Called from the per-minute cron.
 *
 * Best-effort and never throws: reaping is housekeeping, and a failure here
 * must not stop the sweep from claiming real queued work.
 *
 * Returns how many rows it reaped, for the caller to log.
 */
export async function reapStaleRunningJobs(sb: SupabaseClient, nowMs: number = Date.now()): Promise<number> {
  try {
    const cutoff = staleRunningCutoffIso(nowMs);
    const { data } = await sb
      .from("ingest_jobs")
      .update({
        status: "failed",
        finished_at: new Date(nowMs).toISOString(),
        error: `No terminal status after ${STALE_RUNNING_JOB_HOURS}h — the process that claimed this job died without finishing. Reaped by the cron so the row stops blocking re-ingest of this city.`,
      })
      .eq("status", "running")
      .lt("started_at", cutoff)
      .select("id");
    return data?.length ?? 0;
  } catch (e) {
    console.warn(`[jobs] reapStaleRunningJobs failed: ${String(e)}`);
    return 0;
  }
}
