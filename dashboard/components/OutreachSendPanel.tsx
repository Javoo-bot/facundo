"use client";

import { useState } from "react";
import { parseDraft } from "@/lib/outreach";
import type { AppSettings, Florist } from "@/lib/types";

type Row = { florist: Florist; subject: string; body: string };
type Result = { floristId: string; status: "sent" | "failed"; error?: string };

// Must not exceed MAX_IDS in app/api/florists/draft-email/route.ts. "Draft all"
// chunks the selection into batches of this size so a large selection never
// trips the route's cap and fails wholesale.
const MAX_DRAFT_BATCH = 25;

/**
 * Review/edit/send panel for the florists selected in the city table.
 *
 * Safety UX: the test-mode banner is the first thing rendered in the panel
 * (impossible to miss before scrolling to any email content), and sending
 * while test mode is off requires an explicit second click on a distinct
 * "Confirm live send" control — a single click never sends a real email.
 * The client never sends a `test_mode` flag to the API; the server re-reads
 * `app_settings` on every call, so this banner is a preview, not the source
 * of truth.
 */
export default function OutreachSendPanel({
  florists,
  settings,
  onClose,
  onSent,
  onDrafted,
}: {
  florists: Florist[];
  settings: AppSettings | null;
  onClose: () => void;
  onSent: () => void;
  /** Called after one or more drafts are generated + saved, so the parent can
   * refresh (e.g. the table's "draft ready" indicator). */
  onDrafted: () => void;
}) {
  const testMode = settings?.test_mode ?? true;
  const [rows, setRows] = useState<Row[]>(() =>
    florists.map((f) => {
      const p = parseDraft(f.drafted_email);
      return { florist: f, subject: p.subject, body: p.body };
    })
  );
  const [confirmingLive, setConfirmingLive] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [draftingIds, setDraftingIds] = useState<Set<string>>(new Set());
  const [draftError, setDraftError] = useState<string | null>(null);

  const update = (id: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.florist.id === id ? { ...r, ...patch } : r)));

  const draftFor = async (ids: string[]) => {
    if (ids.length === 0) return;
    setDraftError(null);
    setDraftingIds((prev) => new Set([...prev, ...ids]));
    try {
      // The route caps floristIds at MAX_DRAFT_BATCH; "Draft all" over a large
      // selection (Select-all can pick 50+) is chunked so it never trips that
      // cap and fails wholesale. Chunks run sequentially; each florist's row
      // updates as its chunk returns.
      let failureCount = 0;
      let anyOk = false;
      let transportError: string | null = null;
      for (let i = 0; i < ids.length; i += MAX_DRAFT_BATCH) {
        const chunk = ids.slice(i, i + MAX_DRAFT_BATCH);
        const res = await fetch("/api/florists/draft-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ floristIds: chunk }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          results?: { floristId: string; ok: boolean; draft?: string; error?: string }[];
          error?: string;
        };
        if (!res.ok || !j.results) {
          transportError = j.error || `Draft failed (${res.status}).`;
          failureCount += chunk.length;
          continue;
        }
        for (const r of j.results) {
          if (r.ok && r.draft) {
            anyOk = true;
            const p = parseDraft(r.draft);
            update(r.floristId, { subject: p.subject, body: p.body });
          } else {
            failureCount += 1;
          }
        }
      }
      if (failureCount > 0) {
        setDraftError(transportError && !anyOk ? transportError : `${failureCount} draft(s) failed.`);
      }
      if (anyOk) onDrafted();
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : "Draft failed.");
    } finally {
      setDraftingIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  const doSend = async () => {
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/outreach/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: rows.map((r) => ({ floristId: r.florist.id, subject: r.subject, body: r.body })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSendError(j.error || `Send failed (${res.status}).`);
        setResults(
          rows.map((r) => ({
            floristId: r.florist.id,
            status: "failed" as const,
            error: j.error || `Failed (${res.status})`,
          }))
        );
      } else {
        setResults(j.results as Result[]);
        onSent();
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSending(false);
      setConfirmingLive(false);
    }
  };

  const onSendClick = () => {
    if (!testMode) setConfirmingLive(true);
    else doSend();
  };

  const resultFor = (id: string) => results?.find((r) => r.floristId === id);

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review and send outreach"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Test-mode banner — deliberately the first thing in the panel, in
         * high-contrast color, so it's read before any email content. */}
        <div
          className={`rounded-t-lg px-5 py-3 text-sm font-medium ${testMode ? "text-warn" : "text-crit"}`}
          style={{
            background: `color-mix(in srgb, var(${testMode ? "--warn" : "--crit"}) 12%, transparent)`,
          }}
        >
          {testMode
            ? `🧪 TEST MODE — all ${rows.length} email(s) go to ${
                settings?.test_email ?? "(no test email set — configure one in Settings)"
              }`
            : `🔴 LIVE — ${rows.length} email(s) go to the real florists`}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {rows.map((r) => {
            const res = resultFor(r.florist.id);
            return (
              <div key={r.florist.id} className="rounded-md border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">{r.florist.name}</p>
                  <p className="text-xs text-ink-soft">
                    {testMode ? `→ ${settings?.test_email ?? "—"}` : `→ ${r.florist.email}`}
                  </p>
                </div>
                <input
                  value={r.subject}
                  onChange={(e) => update(r.florist.id, { subject: e.target.value })}
                  disabled={sending || results != null}
                  aria-label={`Subject for ${r.florist.name}`}
                  className="mt-2 w-full rounded border border-line-strong px-2 py-1 text-sm disabled:bg-surface-2 disabled:text-ink-soft"
                />
                <textarea
                  value={r.body}
                  onChange={(e) => update(r.florist.id, { body: e.target.value })}
                  disabled={sending || results != null}
                  rows={5}
                  aria-label={`Body for ${r.florist.name}`}
                  className="mt-2 w-full rounded border border-line-strong px-2 py-1 text-xs disabled:bg-surface-2 disabled:text-ink-soft"
                />
                {!results && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => draftFor([r.florist.id])}
                      disabled={draftingIds.has(r.florist.id) || sending}
                      className="rounded border border-line-strong bg-surface px-2 py-1 text-xs font-medium text-ink-soft hover:bg-surface-2 disabled:opacity-40"
                    >
                      {draftingIds.has(r.florist.id) ? "Drafting…" : r.body ? "Regenerate" : "Draft email"}
                    </button>
                  </div>
                )}
                {res && (
                  <p
                    className={`mt-1 text-xs ${
                      res.status === "sent" ? "text-accent" : "text-crit"
                    }`}
                  >
                    {res.status === "sent" ? "✓ sent" : `✗ ${res.error ?? "failed"}`}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-ink-soft hover:text-ink"
          >
            {results ? "Close" : "Cancel"}
          </button>
          {!results && (
            <div className="flex items-center gap-3">
              {draftError && <span className="text-xs text-crit">{draftError}</span>}
              <button
                type="button"
                onClick={() => draftFor(rows.map((r) => r.florist.id))}
                disabled={draftingIds.size > 0 || sending || rows.length === 0}
                className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-surface-2 disabled:opacity-40"
              >
                {draftingIds.size > 0 ? "Drafting…" : `Draft all ${rows.length}`}
              </button>
              {sendError && <span className="text-xs text-crit">{sendError}</span>}
              {confirmingLive ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-crit">
                    Email {rows.length} real florist(s)?
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmingLive(false)}
                    disabled={sending}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-surface-2"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={doSend}
                    disabled={sending}
                    className="rounded-md bg-crit px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {sending ? "Sending…" : "Confirm live send"}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onSendClick}
                  disabled={sending || rows.length === 0}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium text-white shadow-sm disabled:opacity-50 ${
                    testMode ? "bg-accent hover:bg-accent-ink" : "bg-crit hover:brightness-110"
                  }`}
                >
                  {sending ? "Sending…" : `Send ${rows.length}`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
