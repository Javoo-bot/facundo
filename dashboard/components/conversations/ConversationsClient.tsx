"use client";

import { useState } from "react";
import { ESCALATION_REASON_LABEL as REASON_LABEL } from "@/lib/conversationReasons";
import { pageTitle } from "@/lib/brand";

/**
 * CX's view of florist conversations — the surface an escalated AI thread lands
 * on.
 *
 * NOT the /cx desk: that is order-keyed (lib/cxAttention.ts groups by order),
 * and a recruiting conversation has no order. Forcing one in would corrupt the
 * desk's model, which is also why these do not go through `order_approvals`
 * (its `order_id` is NOT NULL).
 */

export interface ConversationMessage {
  id: string;
  direction: "in" | "out";
  body_text: string | null;
  status: string;
  ai_generated: boolean;
  ai_confidence: number | null;
  ai_intent: string | null;
  actor: string | null;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  channel: string;
  kind: string;
  order_id: string | null;
  orders: { order_name: string | null } | null;
  status: string;
  escalation_reason: string | null;
  cx_unread: boolean;
  auto_turns: number;
  last_inbound_at: string | null;
  created_at: string;
  florists: { name: string | null; email: string | null } | null;
  conversation_messages: ConversationMessage[];
}

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function ConversationsClient({
  initialRows,
  error,
}: {
  initialRows: ConversationRow[];
  error: string | null;
}) {
  const [rows, setRows] = useState(initialRows);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);

  const waiting = rows.filter((r) => r.status === "awaiting_human");
  const others = rows.filter((r) => r.status !== "awaiting_human");

  async function act(conversationId: string, action: "send" | "close", text?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/conversations/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, action, text }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `Failed (${res.status}).`);
      setRows((prev) =>
        prev.map((r) =>
          r.id === conversationId
            ? { ...r, status: action === "close" ? "closed" : "bot", cx_unread: false, escalation_reason: null }
            : r
        )
      );
      setOpenId(null);
      setDraft("");
      setNotice({ text: action === "close" ? "Closed." : "Sent.", failed: false });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Something went wrong.", failed: true });
    } finally {
      setBusy(false);
    }
  }

  function openThread(r: ConversationRow) {
    setOpenId(r.id === openId ? null : r.id);
    // Pre-fill with the AI's draft when there is one — approving in one click is
    // most of the value of storing it.
    const lastDraft = [...r.conversation_messages].reverse().find((m) => m.status === "draft");
    setDraft(lastDraft?.body_text ?? "");
    setNotice(null);
  }

  function renderThread(r: ConversationRow) {
    const msgs = [...r.conversation_messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return (
      <div className="mt-3 space-y-2">
        {msgs.map((m) => (
          <div
            key={m.id}
            className="rounded-md border border-line p-2 text-sm"
            style={{ background: m.direction === "in" ? "var(--surface-2)" : "transparent" }}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
              <span className="font-medium">{m.direction === "in" ? "Florist" : m.ai_generated ? "Assistant" : m.actor ?? "Staff"}</span>
              <span>{fmt(m.created_at)}</span>
              {m.status === "draft" && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-warn">draft — not sent</span>}
              {m.status === "suppressed" && <span className="rounded bg-surface-2 px-1.5 py-0.5">suppressed</span>}
              {m.ai_confidence != null && <span>confidence {Number(m.ai_confidence).toFixed(2)}</span>}
              {m.ai_intent && <span>· {m.ai_intent}</span>}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-ink">{m.body_text ?? "—"}</p>
          </div>
        ))}

        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            placeholder="Write the reply. It goes out under the persona this florist has been talking to."
            className="w-full rounded-md border border-line-strong px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-ink-faint">
            Sent as the market&apos;s persona, not as you — switching names mid-thread would tell the florist the
            person they were writing to was never real.
          </p>
          {notice?.failed && openId === r.id && (
            <p className="mt-2 rounded-md border border-crit px-3 py-2 text-sm text-crit" role="alert">
              {notice.text}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || draft.trim() === ""}
              onClick={() => void act(r.id, "send", draft)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-ink disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send reply"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(r.id, "close")}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              Close without replying
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderRow(r: ConversationRow) {
    const who = r.florists?.name ?? r.florists?.email ?? "Unknown sender";
    // An order-scoped thread is a different job from a recruiting one: it is
    // about work in progress, and the answer is usually on the order page.
    const order = r.orders?.order_name ?? (r.order_id ? "an order" : null);
    const lastIn = [...r.conversation_messages].reverse().find((m) => m.direction === "in");
    return (
      <li key={r.id} className="px-3 py-3">
        <button type="button" onClick={() => openThread(r)} className="w-full text-left">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-ink">
              {who}
              {order && (
                <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink-soft">
                  {order}
                </span>
              )}
              {r.kind === "support" && !order && (
                <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-warn">no order</span>
              )}
            </span>
            <span className="text-xs text-ink-faint">
              {r.channel} · {fmt(r.last_inbound_at)}
              {r.auto_turns > 0 && ` · ${r.auto_turns} auto ${r.auto_turns === 1 ? "reply" : "replies"}`}
            </span>
          </div>
          {r.escalation_reason && (
            <p className="mt-0.5 text-xs text-warn">
              {REASON_LABEL[r.escalation_reason] ?? r.escalation_reason}
            </p>
          )}
          {lastIn?.body_text && (
            <p className="mt-1 truncate text-sm text-ink-soft">{lastIn.body_text}</p>
          )}
        </button>
        {openId === r.id && renderThread(r)}
      </li>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <p className="eyebrow">Backoffice</p>
      <h1>{pageTitle("Conversations")}</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Replies from florists, and the threads the assistant handed over. Two kinds land here: shops we are
        recruiting, and shops in the network asking about an order they are holding. For a prospect, anything
        about money is escalated before a reply goes out. For a live order the assistant may state what we have
        already paid, read from that order, and nothing else.
      </p>

      {error && <p className="mt-4 rounded-md border border-crit px-3 py-2 text-sm text-crit">{error}</p>}
      {/* Success still reports at the top, where the list is. A FAILURE also
          reports next to the button that failed (below) — this banner is above
          the "Waiting for a person" heading, so on any thread further down the
          page a rejected send changed nothing the sender could see. That is
          what "I click send and nothing happens" was: a 409 rendered
          off-screen. */}
      {notice && !notice.failed && (
        <p className="mt-4 rounded-md border border-line px-3 py-2 text-sm">{notice.text}</p>
      )}

      <h2 className="mt-6 text-sm font-semibold text-ink">
        Waiting for a person {waiting.length > 0 && <span className="text-warn">({waiting.length})</span>}
      </h2>
      <ul className="mt-2 divide-y divide-line rounded-md border border-line">
        {waiting.length === 0 ? (
          <li className="px-3 py-3 text-sm text-ink-soft">Nothing waiting.</li>
        ) : (
          waiting.map(renderRow)
        )}
      </ul>

      {others.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold text-ink">Everything else</h2>
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">{others.map(renderRow)}</ul>
        </>
      )}
    </div>
  );
}
