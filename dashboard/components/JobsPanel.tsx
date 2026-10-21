"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SimpleToast from "@/components/SimpleToast";
import { IconBell, IconCheckCircle, IconClock, IconSpinner, IconXCircle } from "@/components/icons";
import { totalCost, formatUsd, durationMs, formatDuration } from "@/lib/cost";
import { useToasts } from "@/lib/useToasts";
import type { IngestJob } from "@/lib/types";

// Adaptive polling: fast only while a job is active, slow when idle, and
// paused entirely while the tab is hidden. A fixed 2s always-on poll was
// ~14k needless /api/jobs requests per open tab per 8-hour day on Workers
// Paid (each also runs a Supabase query) — almost all of it while nothing
// was ingesting. See the cost note.
const ACTIVE_POLL_MS = 4000;
const IDLE_POLL_MS = 30000;
const TITLE_ID = "jobs-panel-title";

function timeAgo(iso: string): string {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function StatusIcon({ status }: { status: IngestJob["status"] }) {
  if (status === "queued") {
    return <IconClock className="h-4 w-4 shrink-0 text-warn" />;
  }
  if (status === "running") {
    return <IconSpinner className="h-4 w-4 shrink-0 animate-spin text-accent" />;
  }
  if (status === "succeeded") {
    return <IconCheckCircle className="h-4 w-4 shrink-0 text-accent" />;
  }
  return <IconXCircle className="h-4 w-4 shrink-0 text-crit" />;
}

function JobRow({ job }: { job: IngestJob }) {
  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <StatusIcon status={job.status} />
        <span className="truncate text-sm font-medium text-ink">
          {job.city}, {job.country}
        </span>
      </div>
      <p className="mt-1 truncate text-xs text-ink-soft" title={job.last_line ?? undefined}>
        {job.last_line ??
          (job.status === "running"
            ? "Starting…"
            : job.status === "queued"
              ? "Queued — waiting for the ingest host to pick it up…"
              : "—")}
      </p>
      {job.status === "failed" && job.error && (
        <p className="mt-1 text-xs text-crit">{job.error}</p>
      )}
      {(job.status === "succeeded" || job.status === "failed") && (
        <div className="mt-1.5 space-y-0.5">
          <p className="text-xs font-medium tabular-nums text-ink-soft">
            {formatDuration(durationMs(job))}
            {job.florist_count != null && <> · {job.florist_count} florists</>}
            {" · "}
            {formatUsd(totalCost(job))}
          </p>
          <p className="text-[11px] tabular-nums text-ink-faint">
            Apify {formatUsd(job.apify_cost_usd)} · LLM {formatUsd(job.llm_cost_usd)}
            {job.llm_calls != null && <> · {job.llm_calls} calls</>}
            {job.input_tokens != null && job.output_tokens != null && (
              <>
                {" "}
                · {job.input_tokens.toLocaleString()}/{job.output_tokens.toLocaleString()} tok
              </>
            )}
          </p>
        </div>
      )}
      {job.status === "running" && (
        <p className="mt-1.5 text-[11px] text-ink-faint">Cost calculating…</p>
      )}
      {job.status === "queued" && (
        <p className="mt-1.5 text-[11px] text-ink-faint">Not started yet</p>
      )}
      <p className="mt-1.5 text-[11px] text-ink-faint">Started {timeAgo(job.started_at)}</p>
    </li>
  );
}

/**
 * Header jobs indicator + right-side jobs drawer, shared by the Overview
 * header (PipelineHome) and the city dashboard header (DashboardClient) —
 * see docs/superpowers/specs/2026-07-02-background-jobs-design.md
 * "Visibility UI". Self-contained: owns its own polling, open/close state,
 * and a success toast, so both call sites just drop it in next to UserMenu.
 *
 * Judgment call: implemented as a right-side slide-over (bg-black/40 backdrop
 * + panel sliding in from the right, closes on backdrop click or Escape)
 * rather than a dropdown — the design spec explicitly calls it a "drawer",
 * and this codebase already has one full-screen-backdrop modal convention
 * (AddCityDialog/HowDataCollectedModal) to match, just anchored right instead
 * of centered. Unlike AddCityDialog, this panel skips a full focus trap /
 * `inert` background — it's read-only status, not a data-entry flow, so the
 * stricter a11y treatment felt like overkill for a POC.
 */
export default function JobsPanel() {
  const router = useRouter();
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [open, setOpen] = useState(false);
  const prevStatusRef = useRef<Map<string, IngestJob["status"]>>(new Map());
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(tick, ms);
    };

    const tick = async () => {
      // Don't hit the network while the tab is hidden — a backgrounded
      // dashboard shouldn't poll. We re-poll immediately on visibilitychange.
      if (typeof document !== "undefined" && document.hidden) {
        schedule(IDLE_POLL_MS);
        return;
      }
      let active = false;
      try {
        const res = await fetch("/api/jobs", { cache: "no-store" });
        if (res.ok && !cancelled) {
          const data = (await res.json()) as { jobs: IngestJob[] };
          if (!cancelled) {
            // running -> succeeded transitions: toast + refresh the overview
            // data underneath so the newly-ingested city shows up.
            let anySucceeded = false;
            for (const job of data.jobs) {
              const prevStatus = prevStatusRef.current.get(job.id);
              if (prevStatus === "running" && job.status === "succeeded") {
                push("success", `${job.city}, ${job.country} finished ingesting.`);
                anySucceeded = true;
              }
            }
            prevStatusRef.current = new Map(data.jobs.map((job) => [job.id, job.status]));
            setJobs(data.jobs);
            // Poll fast only for a genuinely in-flight job. A job stuck in
            // "running"/"queued" for a long time is a crashed run, not live
            // work — don't let it pin the poll at the fast rate forever. A real
            // ingest finishes in minutes; 20 min is a safe staleness cutoff.
            active = data.jobs.some((j) => {
              if (j.status !== "running" && j.status !== "queued") return false;
              const started = Date.parse(j.started_at);
              return Number.isNaN(started) || Date.now() - started < 20 * 60 * 1000;
            });
            if (anySucceeded) router.refresh();
          }
        }
      } catch {
        // Transient poll failure — the next tick tries again.
      }
      // Poll often while something is in flight; back off hard when idle.
      schedule(active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };

    tick();
    const onVisible = () => {
      if (!document.hidden) {
        if (timer) clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [push, router]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // "Active" = running OR queued-but-not-yet-claimed — both should light up the
  // header bell so a pending job on the deployment isn't invisible.
  const runningCount = jobs.filter(
    (j) => j.status === "running" || j.status === "queued"
  ).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={runningCount > 0 ? `Ingest jobs, ${runningCount} running` : "Ingest jobs"}
        title="Ingest jobs"
        className="relative rounded-md border border-line bg-surface p-1.5 text-ink-soft shadow-sm transition hover:border-accent hover:text-ink"
      >
        <IconBell className={`h-4 w-4 ${runningCount > 0 ? "animate-pulse text-accent" : ""}`} />
        {runningCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-white"
          >
            {runningCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[1100] bg-black/40 animate-overview-backdrop-fade"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={TITLE_ID}
            className="fixed inset-y-0 right-0 flex w-full max-w-sm flex-col overflow-y-auto bg-surface p-5 shadow-2xl animate-overview-drawer-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 id={TITLE_ID} className="text-base font-semibold text-ink">
                Ingest jobs
              </h2>
              <div className="flex items-center gap-1">
                <Link
                  href="/jobs"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2 py-1 text-sm font-medium text-accent-ink hover:bg-surface-2"
                >
                  All runs →
                </Link>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="rounded-md px-2 py-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft"
                >
                  &times;
                </button>
              </div>
            </div>

            {jobs.length === 0 ? (
              <p className="mt-6 text-sm text-ink-faint">No ingest jobs yet.</p>
            ) : (
              <ul className="mt-4 space-y-2.5">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <SimpleToast toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
