"use client";

import { useState } from "react";

/**
 * Who is mid-funnel, and where.
 *
 * The gap this closes: enrolment happened only as a side effect of sending the
 * day-0 email, so staff could start a funnel but had no way to see who was in
 * one, what they had already received, or stop a run without going through the
 * florist's own page.
 */

export interface EnrolmentRow {
  id: string;
  sequence_id: string;
  status: string;
  track: string;
  step_index: number;
  next_action_at: string | null;
  engaged_at: string | null;
  last_touch_at: string | null;
  touches_email: number;
  touches_sms: number;
  stop_reason: string | null;
  created_at: string;
  florists: { name: string | null; email: string | null } | null;
}

const SEQUENCE_LABEL: Record<string, string> = {
  recruit_cold: "Cold recruiting",
  cold_offer_followup: "Cold-offer follow-up",
};

// What the next touch will be, given where the run stands. Mirrors
// lib/sequences/definitions.ts — shown so "step 2" means something to a reader.
const NEXT_TOUCH: Record<string, string[]> = {
  cold: ["1 · first email", "2 · we're short here", "3 · how the money works", "— done"],
  reengage: ["R1 · what stopped you?", "R2 · closing this off", "— done"],
};

const STOP_REASON_LABEL: Record<string, string> = {
  joined: "joined the network",
  opted_out: "opted out",
  bounced: "address bounced",
  exhausted: "saw every touch",
  cap_cold: "hit the touch cap",
  cap_email: "hit the email cap",
  staff: "stopped by staff",
  replied: "replied",
};

function when(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function SequencesClient({
  initialRows,
  error,
  engineOn,
}: {
  initialRows: EnrolmentRow[];
  error: string | null;
  engineOn: boolean;
}) {
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const live = rows.filter((r) => r.status === "active" || r.status === "paused");
  const done = rows.filter((r) => r.status !== "active" && r.status !== "paused");

  async function stopRun(id: string) {
    setBusy(id);
    setNotice(null);
    try {
      const res = await fetch("/api/sequences/enrolments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrolmentId: id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `Failed (${res.status}).`);
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "stopped", stop_reason: "staff" } : r))
      );
      setNotice("Run stopped.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  function row(r: EnrolmentRow, showStop: boolean) {
    const who = r.florists?.name ?? r.florists?.email ?? "Unknown shop";
    const nextTouch = NEXT_TOUCH[r.track]?.[r.step_index] ?? "— done";
    return (
      <li key={r.id} className="px-3 py-3 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-ink">{who}</p>
            <p className="text-xs text-ink-faint">
              {SEQUENCE_LABEL[r.sequence_id] ?? r.sequence_id}
              {" · "}
              {r.engaged_at ? "clicked — re-engagement track" : "no click yet — cold track"}
              {r.status === "paused" && " · paused for an order offer"}
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              Next: {nextTouch}
              {r.status === "active" && r.next_action_at ? ` · due ${when(r.next_action_at)}` : ""}
              {" · "}
              {r.touches_email} email{r.touches_email === 1 ? "" : "s"}
              {r.touches_sms > 0 ? `, ${r.touches_sms} text${r.touches_sms === 1 ? "" : "s"}` : ""} sent
            </p>
            {!showStop && (
              <p className="mt-0.5 text-xs text-ink-faint">
                Ended: {STOP_REASON_LABEL[r.stop_reason ?? ""] ?? r.status}
              </p>
            )}
          </div>
          {showStop && (
            <button
              type="button"
              disabled={busy === r.id}
              onClick={() => void stopRun(r.id)}
              className="shrink-0 rounded-md border border-crit px-2.5 py-1 text-xs font-medium text-crit hover:bg-surface-2 disabled:opacity-50"
            >
              {busy === r.id ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <p className="eyebrow">Backoffice</p>
      <h1>Outreach sequences</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Florists partway through a recruiting funnel — what they&apos;ve had, what&apos;s next, and when.
      </p>

      {!engineOn && (
        <p className="mt-4 rounded-md border border-warn px-3 py-2 text-sm text-warn">
          The sequence engine is turned off in Settings, so nothing is being sent. Runs below are frozen where
          they stand; turning it on resumes them from there rather than starting over.
        </p>
      )}
      {error && <p className="mt-4 rounded-md border border-crit px-3 py-2 text-sm text-crit">{error}</p>}
      {notice && <p className="mt-4 rounded-md border border-line px-3 py-2 text-sm">{notice}</p>}

      <h2 className="mt-6 text-sm font-semibold text-ink">In progress ({live.length})</h2>
      <ul className="mt-2 divide-y divide-line rounded-md border border-line">
        {live.length === 0 ? (
          <li className="px-3 py-3 text-sm text-ink-soft">
            Nobody is mid-funnel. Sending a recruiting email from Discovery starts a run.
          </li>
        ) : (
          live.map((r) => row(r, true))
        )}
      </ul>

      {done.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold text-ink">Finished ({done.length})</h2>
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {done.map((r) => row(r, false))}
          </ul>
          <p className="mt-2 text-xs text-ink-faint">
            &ldquo;Saw every touch&rdquo; is the normal end — the prospect got the whole sequence. A finished run
            frees that shop to be enrolled again later.
          </p>
        </>
      )}
    </div>
  );
}
