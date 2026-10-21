"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OrderIssue, IssueMessage } from "@/lib/types";
import Button from "@/components/ui/Button";
import IssueThread from "@/components/issues/IssueThread";

// The resolutions offered, in a sensible order. `warn` styles the money/terminal ones.
const ACTIONS: { key: string; label: string; warn?: boolean }[] = [
  { key: "substitute", label: "Approve substitution" },
  { key: "reassign", label: "Reassign" },
  { key: "redeliver", label: "Redeliver" },
  { key: "clawback", label: "Clawback", warn: true },
  { key: "cancel", label: "Cancel order", warn: true },
  { key: "dismiss", label: "Dismiss" },
];

export default function OrderIssues({ issues, messages = [] }: { issues: OrderIssue[]; messages?: IssueMessage[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function resolve(issueId: string, action: string) {
    setBusy(issueId + action);
    setErr(null);
    try {
      const res = await fetch("/api/orders/issues/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId, action }),
      });
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? "Resolve failed."); return; }
      router.refresh();
    } finally { setBusy(null); }
  }

  if (issues.length === 0) return null;
  // Open first, then most-recent.
  const sorted = [...issues].sort((a, b) =>
    a.status === b.status ? (a.created_at < b.created_at ? 1 : -1) : a.status === "open" ? -1 : 1,
  );
  const openCount = issues.filter((i) => i.status === "open").length;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="mini-h" style={{ color: openCount ? "var(--warn)" : "var(--ink-soft)" }}>
        {openCount ? `⚠ Issues (${openCount} open)` : "Issues"}
      </div>
      {sorted.map((issue) => (
        <div key={issue.id} style={{ display: "grid", gap: 8 }}>
          <IssueThread
            issue={issue}
            messages={messages.filter((m) => m.issue_id === issue.id)}
            role="staff"
            replyUrl="/api/orders/issues/reply"
          />
          {issue.status === "open" && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {ACTIONS.map((a) => (
                <Button key={a.key} variant={a.warn ? "warn" : "default"} disabled={busy !== null} onClick={() => resolve(issue.id, a.key)}>
                  {a.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      ))}
      {err && <div style={{ color: "var(--crit)", fontSize: ".8rem" }}>{err}</div>}
    </div>
  );
}
