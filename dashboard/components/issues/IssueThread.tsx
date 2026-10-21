"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OrderIssue, IssueMessage } from "@/lib/types";
import Button from "@/components/ui/Button";
import { issueLabel } from "@/lib/i18n/issueLabels";
import { useT } from "@/components/florist/LocaleProvider";

function fmt(iso: string): string {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

// One issue's conversation. `role` is who "I" am (florist vs staff) — it aligns
// my messages right, decides the reply endpoint, and labels the other side.
export default function IssueThread({
  issue,
  messages,
  role,
  replyUrl,
}: {
  issue: OrderIssue;
  messages: IssueMessage[];
  role: "florist" | "staff";
  replyUrl: string;
}) {
  const router = useRouter();
  const { locale, t } = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const myRole = role === "florist" ? "florist" : "cx";
  const resolved = issue.status === "resolved";

  async function send() {
    const body = text.trim();
    if (!body) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(replyUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: issue.id, body }),
      });
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? t("ui.messages.thread.errorSend")); return; }
      setText(""); router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ display: "grid", gap: 10, borderColor: resolved ? "var(--line)" : "var(--warn)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontSize: ".92rem" }}>{issueLabel(locale, issue.type)}</b>
        <span className={`badge ${resolved ? "badge-accent" : "badge-warn"}`}>{resolved ? t("ui.messages.thread.resolved") : t("ui.messages.thread.open")}</span>
        {issue.stage && <span className="badge badge-neutral">{issue.stage}</span>}
        <span style={{ marginLeft: "auto", fontSize: ".72rem", color: "var(--ink-faint)" }}>{fmt(issue.created_at)}</span>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {messages.length === 0 && <p style={{ fontSize: ".82rem", color: "var(--ink-faint)" }}>{t("ui.messages.thread.noMessagesYet")}</p>}
        {messages.map((m) => {
          const mine = m.author_role === myRole;
          const system = m.author_role === "system";
          if (system) {
            return (
              <div key={m.id} style={{ textAlign: "center", fontSize: ".76rem", color: "var(--ink-faint)", padding: "2px 0" }}>
                {m.body} · {fmt(m.created_at)}
              </div>
            );
          }
          const who = m.author_role === "florist" ? t("ui.messages.thread.roleFlorist") : t("ui.messages.thread.roleCx");
          return (
            <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
              <div
                style={{
                  maxWidth: "80%", padding: "8px 11px", borderRadius: 12, fontSize: ".85rem",
                  background: mine ? "var(--accent)" : "var(--surface-2)",
                  color: mine ? "var(--on-accent, #fff)" : "var(--ink)",
                  border: mine ? "none" : "1px solid var(--line)",
                }}
              >
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{m.body}</div>
                <div style={{ marginTop: 3, fontSize: ".66rem", opacity: 0.75 }}>{who} · {fmt(m.created_at)}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
          placeholder={resolved ? t("ui.messages.thread.placeholderFollowUp") : t("ui.messages.thread.placeholderNew")}
          rows={2}
          style={{ flex: 1, resize: "vertical", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--surface)", color: "var(--ink)", fontSize: ".85rem", fontFamily: "inherit" }}
        />
        <Button variant="solid" disabled={busy || !text.trim()} onClick={send}>{t("ui.messages.thread.send")}</Button>
      </div>
      {err && <div style={{ color: "var(--crit)", fontSize: ".78rem" }}>{err}</div>}
    </div>
  );
}
