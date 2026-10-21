"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/florist/LocaleProvider";
import type { ThreadMessage } from "@/lib/supportThread";

/**
 * The florist asks about one of their orders, and gets an answer.
 *
 * A launcher bubble and a docked panel, because that is the shape people
 * already know support chat to be — the previous inline textbox read as a
 * form, and a form is something you fill in once.
 *
 * Three things this deliberately does NOT do:
 *
 *   1. Pretend to be a person. The disclosure sits under the composer, always
 *      visible, not behind a tooltip. The agent also admits it outright when
 *      asked (lib/cxAgentGuard.ts::replyDisclosesAi refuses to send a reply to
 *      "are you a bot?" that does not say so), so hiding it here would only
 *      make the product inconsistent with itself.
 *   2. Replace "Report a problem". Free text cannot open an order_issue, and an
 *      order_issue is what actually moves money — so the one chip that is about
 *      something being WRONG doesn't send a message at all. It closes the panel
 *      and takes the florist to the control that reaches someone who can act.
 *   3. Offer a quick reply the agent cannot answer. Every chip below maps to a
 *      line lib/supportFacts.ts actually produces. "Where is it going?" used to
 *      be absent for exactly this reason — the fact list carried no address —
 *      but supportFacts now includes delivery address and recipient once the
 *      florist has accepted (the same PII gate the order page uses), so the
 *      chip is grounded and safe to offer.
 *
 * When the agent escalates there is no reply to show. That case gets its own
 * line rather than silence: a florist staring at their own unanswered message
 * assumes it went nowhere, and writes in again by email.
 */

/** Quick replies, in the order a florist asks them. `key` is the catalog leaf;
 * the label IS the message sent, so it arrives in the florist's own language
 * and reads like something a person typed. */
const QUICK_REPLIES = ["pay", "photo", "due", "address"] as const;

const PANEL_WIDTH = 380;
/** Clears the PWA's fixed bottom tab bar (FloristShell TAB_BAR_HEIGHT = 56). */
const ABOVE_TAB_BAR = "calc(56px + env(safe-area-inset-bottom) + 14px)";

export default function OrderChat({
  assignmentId,
  initialMessages,
  initialEscalated,
}: {
  assignmentId: string;
  initialMessages: ThreadMessage[];
  initialEscalated: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);

  const [escalated, setEscalated] = useState(initialEscalated);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  // The SERVER is the source of truth for this thread, and useState only ever
  // read the first render's value — so when a colleague answered from /cx, or
  // the agent's reply was approved, the florist's chat kept showing the old
  // list until a hard reload. The florist layout already re-renders this page
  // on a timer (components/AutoRefresh), which was quietly doing nothing here.
  //
  // Adopt the server's list whenever its message ids change, EXCEPT while a
  // send is in flight: that is the one moment the local list is deliberately
  // ahead of the server (the optimistic message), and replacing it would make
  // the florist's own words vanish as they watch.
  const serverIds = initialMessages.map((m) => m.id).join("|");
  useEffect(() => {
    if (busy) return;
    setMessages(initialMessages);
    // `serverIds` stands in for the identity of `initialMessages`: the server
    // hands down a fresh array on every render, so depending on the array
    // itself would re-run this forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIds, busy]);

  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Quick replies are a way IN to the conversation, not a permanent menu: once
  // the florist has said something they know they can type.
  const showQuickReplies = !messages.some((m) => m.direction === "in");

  const send = useCallback(
    async (bodyText: string) => {
      const body = bodyText.trim();
      if (!body || busy) return;
      setBusy(true);
      setError(false);

      // Shown immediately with a temporary id. The server is the source of
      // truth for everything else, but a florist on a phone should never
      // wonder whether their tap registered.
      const pending: ThreadMessage = {
        id: `pending-${Date.now()}`,
        direction: "in",
        body_text: body,
        ai_generated: false,
        actor: "florist",
        created_at: new Date().toISOString(),
      };
      setMessages((m) => [...m, pending]);
      setText("");

      try {
        const res = await fetch("/api/florist/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignmentId, text: body }),
        });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error("failed");

        if (j.reply) {
          setMessages((m) => [
            ...m,
            {
              id: `reply-${Date.now()}`,
              direction: "out",
              body_text: j.reply as string,
              ai_generated: true,
              actor: null,
              created_at: new Date().toISOString(),
            },
          ]);
        }
        setEscalated(Boolean(j.escalated));
      } catch {
        // The message is still on record server-side unless the request never
        // arrived, so the retry affordance is the composer, not a resend button.
        setError(true);
        setMessages((m) => m.filter((x) => x.id !== pending.id));
        setText(body);
      } finally {
        setBusy(false);
      }
    },
    [assignmentId, busy]
  );

  /** The one chip that is not a question. Only "Report a problem" can open an
   * order_issue, so this hands the florist to it rather than quietly turning a
   * real problem into a chat message nobody acts on. */
  const goToReportProblem = useCallback(() => {
    setOpen(false);
    const target = document.getElementById("fc-report-problem");
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    // Open the reason picker too: landing next to a button they still have to
    // find is most of the way to giving up.
    window.setTimeout(() => target.click(), 350);
  }, []);

  // Keep the newest message in view, including the one that just arrived.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [open, messages, busy]);

  // Focus the composer on open; hand focus back to the launcher on close, so a
  // keyboard user isn't dropped at the top of the document.
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else launcherRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <style>{CSS}</style>

      {/* Launcher. Hidden while the panel is open — on a phone the panel covers
          the screen and a floating button on top of it is just clutter. */}
      <button
        ref={launcherRef}
        type="button"
        className="fc-chat-launcher"
        aria-expanded={open}
        aria-label={t("ui.orderDetail.detail.chat.title")}
        onClick={() => setOpen((o) => !o)}
        style={{ display: open ? "none" : undefined, bottom: ABOVE_TAB_BAR }}
      >
        <IconChat />
        <span className="fc-chat-launcher-label">{t("ui.orderDetail.detail.chat.title")}</span>
        {escalated && <span className="fc-chat-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div
          className="fc-chat-panel"
          role="dialog"
          aria-modal="false"
          aria-label={t("ui.orderDetail.detail.chat.title")}
          style={{ bottom: ABOVE_TAB_BAR }}
        >
          <header className="fc-chat-head">
            <span className="fc-chat-avatar" aria-hidden="true">
              <IconChat />
            </span>
            <span className="fc-chat-head-text">
              <b>{t("ui.orderDetail.detail.chat.title")}</b>
              <small>{t("ui.orderDetail.detail.chat.subtitle")}</small>
            </span>
            <button
              type="button"
              className="fc-chat-close"
              onClick={() => setOpen(false)}
              aria-label={t("ui.orderDetail.detail.chat.close")}
            >
              ✕
            </button>
          </header>

          <div className="fc-chat-thread">
            {/* Opening line from the assistant, so the panel is never an empty
                box asking the florist to think of something. */}
            <Bubble side="out">{t("ui.orderDetail.detail.chat.intro")}</Bubble>

            {messages.map((m) => (
              <Bubble key={m.id} side={m.direction === "in" ? "in" : "out"}>
                {m.body_text}
              </Bubble>
            ))}

            {busy && (
              <div className="fc-chat-typing" role="status" aria-label={t("ui.orderDetail.detail.chat.sending")}>
                <span />
                <span />
                <span />
              </div>
            )}

            {showQuickReplies && !busy && (
              <div className="fc-chat-quick">
                {QUICK_REPLIES.map((k) => {
                  const label = t(`ui.orderDetail.detail.chat.quick.${k}`);
                  return (
                    <button key={k} type="button" className="fc-chat-chip" onClick={() => void send(label)}>
                      {label}
                    </button>
                  );
                })}
                <button type="button" className="fc-chat-chip fc-chat-chip-warn" onClick={goToReportProblem}>
                  ⚠ {t("ui.orderDetail.detail.chat.quick.problem")}
                </button>
              </div>
            )}

            {escalated && <p className="fc-chat-note">{t("ui.orderDetail.detail.chat.escalated")}</p>}
            {error && (
              <p className="fc-chat-note" style={{ color: "var(--crit)" }}>
                {t("ui.orderDetail.detail.chat.error")}
              </p>
            )}
            <div ref={endRef} />
          </div>

          <div className="fc-chat-foot">
            <div className="fc-chat-composer">
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(text);
                  }
                }}
                maxLength={4000}
                placeholder={t("ui.orderDetail.detail.chat.placeholder")}
                aria-label={t("ui.orderDetail.detail.chat.placeholder")}
              />
              <button
                type="button"
                className="fc-chat-send"
                onClick={() => void send(text)}
                disabled={busy || !text.trim()}
                aria-label={t("ui.orderDetail.detail.chat.send")}
              >
                ➤
              </button>
            </div>
            <p className="fc-chat-disclosure">{t("ui.orderDetail.detail.chat.disclosure")}</p>
          </div>
        </div>
      )}
    </>
  );
}

function Bubble({ side, children }: { side: "in" | "out"; children: React.ReactNode }) {
  return <div className={`fc-chat-bubble fc-chat-bubble-${side}`}>{children}</div>;
}

function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 5.25h15a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5H9l-4.5 3.5v-3.5A1.5 1.5 0 013 14.75v-8a1.5 1.5 0 011.5-1.5z" />
    </svg>
  );
}

// Scoped CSS rather than inline styles: bubbles need pseudo-elements for the
// tail and the typing dots need keyframes, neither of which the style prop can
// express. Every value resolves through design-system.css tokens, so both
// themes come for free.
const CSS = `
.fc-chat-launcher {
  position: fixed; right: 14px; z-index: 50;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 11px 16px 11px 13px; border-radius: 999px; border: none;
  background: var(--accent); color: #fff; cursor: pointer;
  font: 600 .85rem/1 var(--sans);
  box-shadow: 0 6px 20px rgba(20,40,30,.28);
}
.fc-chat-launcher svg { width: 19px; height: 19px; flex-shrink: 0; }
.fc-chat-launcher:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.fc-chat-dot {
  position: absolute; top: 8px; right: 10px; width: 9px; height: 9px;
  border-radius: 50%; background: var(--crit); border: 2px solid var(--accent);
}
@media (prefers-color-scheme: dark) { .ds:not([data-theme="light"]) .fc-chat-launcher { color: #0E1512; } }
.ds[data-theme="dark"] .fc-chat-launcher { color: #0E1512; }
/* Below 420px the label costs more than it earns — the icon is the affordance. */
@media (max-width: 420px) {
  .fc-chat-launcher { padding: 14px; }
  .fc-chat-launcher-label { display: none; }
}

.fc-chat-panel {
  position: fixed; right: 14px; left: auto; z-index: 51;
  width: ${PANEL_WIDTH}px; max-width: calc(100vw - 28px);
  height: min(560px, calc(100dvh - 150px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 16px; box-shadow: 0 12px 40px rgba(20,40,30,.26);
}
@media (max-width: 420px) { .fc-chat-panel { left: 14px; width: auto; } }

.fc-chat-head {
  display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 14px;
  border-bottom: 1px solid var(--line); background: var(--surface-2);
}
.fc-chat-avatar {
  display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0;
  border-radius: 50%; background: var(--accent); color: #fff;
}
.fc-chat-avatar svg { width: 17px; height: 17px; }
@media (prefers-color-scheme: dark) { .ds:not([data-theme="light"]) .fc-chat-avatar { color: #0E1512; } }
.ds[data-theme="dark"] .fc-chat-avatar { color: #0E1512; }
.fc-chat-head-text { display: grid; gap: 1px; flex: 1; min-width: 0; }
.fc-chat-head-text b { font-size: .9rem; color: var(--ink); }
.fc-chat-head-text small { font-size: .74rem; color: var(--ink-faint); }
.fc-chat-close {
  border: none; background: transparent; cursor: pointer; padding: 6px;
  color: var(--ink-faint); font-size: .95rem; line-height: 1; border-radius: 6px;
}
.fc-chat-close:hover { color: var(--ink); background: var(--surface); }

.fc-chat-thread {
  flex: 1; overflow-y: auto; padding: 14px 12px;
  display: flex; flex-direction: column; gap: 8px;
}

.fc-chat-bubble {
  position: relative; max-width: 84%; padding: 9px 12px; border-radius: 14px;
  font-size: .87rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere;
}
.fc-chat-bubble-out {
  align-self: flex-start; background: var(--surface-2); color: var(--ink);
  border-bottom-left-radius: 4px;
}
.fc-chat-bubble-in {
  align-self: flex-end; background: var(--accent); color: #fff;
  border-bottom-right-radius: 4px;
}
@media (prefers-color-scheme: dark) { .ds:not([data-theme="light"]) .fc-chat-bubble-in { color: #0E1512; } }
.ds[data-theme="dark"] .fc-chat-bubble-in { color: #0E1512; }

.fc-chat-typing { align-self: flex-start; display: flex; gap: 4px; padding: 11px 13px;
  background: var(--surface-2); border-radius: 14px; border-bottom-left-radius: 4px; }
.fc-chat-typing span {
  width: 6px; height: 6px; border-radius: 50%; background: var(--ink-faint);
  animation: fc-chat-blink 1.2s infinite ease-in-out;
}
.fc-chat-typing span:nth-child(2) { animation-delay: .18s; }
.fc-chat-typing span:nth-child(3) { animation-delay: .36s; }
@keyframes fc-chat-blink { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .fc-chat-typing span { animation: none; opacity: .6; } }

.fc-chat-quick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.fc-chat-chip {
  padding: 8px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--accent); background: transparent; color: var(--accent-ink);
  font: 600 .8rem/1.2 var(--sans); text-align: left;
}
.fc-chat-chip:hover { background: var(--tA-wash); }
.fc-chat-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* The one chip that isn't a question, and shouldn't look like one. */
.fc-chat-chip-warn { border-color: var(--warn); color: var(--warn); }
.fc-chat-chip-warn:hover { background: color-mix(in srgb, var(--warn) 10%, transparent); }

.fc-chat-note { margin: 4px 0 0; font-size: .8rem; color: var(--ink-soft); }

.fc-chat-foot { border-top: 1px solid var(--line); padding: 10px 12px 11px; background: var(--surface); }
.fc-chat-composer { display: flex; gap: 8px; align-items: center; }
.fc-chat-composer input {
  flex: 1; min-width: 0; padding: 10px 14px; border-radius: 999px;
  border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink);
  font-size: .87rem;
}
.fc-chat-composer input:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.fc-chat-send {
  flex-shrink: 0; width: 38px; height: 38px; border-radius: 50%; border: none;
  background: var(--accent); color: #fff; cursor: pointer; font-size: .9rem;
}
.fc-chat-send:disabled { opacity: .45; cursor: not-allowed; }
@media (prefers-color-scheme: dark) { .ds:not([data-theme="light"]) .fc-chat-send { color: #0E1512; } }
.ds[data-theme="dark"] .fc-chat-send { color: #0E1512; }
.fc-chat-disclosure { margin: 8px 2px 0; font-size: .72rem; line-height: 1.35; color: var(--ink-faint); }
`;
