"use client";
import { useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

export default function StatsChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!input.trim() || busy) return;
    const next = [...messages, { role: "user" as const, content: input.trim() }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/stats/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const json = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
      if (!res.ok || json.error) {
        setError(json.error ?? "The chat failed to respond.");
        return;
      }
      setMessages([...next, { role: "assistant", content: json.reply ?? "" }]);
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <h3 style={{ fontSize: ".9rem", fontWeight: 600, color: "var(--ink)" }}>Ask about the data</h3>
      {messages.length === 0 && !error && (
        <p style={{ fontSize: ".82rem", color: "var(--ink-faint)" }}>
          Ask a free-form question — e.g. &ldquo;which florist has the most declines this month?&rdquo; The chat writes
          and runs read-only SQL against the live schema to answer.
        </p>
      )}
      {messages.length > 0 && (
        <div style={{ display: "grid", gap: 8, maxHeight: 360, overflowY: "auto" }}>
          {messages.map((m, i) => (
            <div key={i} style={{ justifySelf: m.role === "user" ? "end" : "start", maxWidth: "85%" }}>
              <p
                style={{
                  fontSize: ".85rem",
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: m.role === "user" ? "var(--accent)" : "var(--surface-2)",
                  color: m.role === "user" ? "#fff" : "var(--ink)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.content}
              </p>
            </div>
          ))}
        </div>
      )}
      {error && <p style={{ color: "var(--crit)", fontSize: ".8rem" }} role="alert">{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <label className="sr-only" htmlFor="stats-chat-input">Ask about the data</label>
        <input
          id="stats-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder="e.g. which florist has the most declines this month?"
          style={{
            flex: 1, height: 40, padding: "0 10px", background: "var(--surface-2)", color: "var(--ink)",
            border: "1px solid var(--line-strong)", borderRadius: 8,
          }}
          disabled={busy}
        />
        <button type="button" className="btn btn-solid" onClick={send} disabled={busy || !input.trim()}>
          {busy ? "Thinking…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
