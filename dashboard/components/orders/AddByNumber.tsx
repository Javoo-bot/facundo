"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseOrderNames } from "@/lib/workingSet";

/** Paste a list of order numbers straight into the working set.
 *
 * Lives here rather than in Settings because the working set is an ops tool:
 * every other way of driving it (ticking rows, the "Working set: N" chip) is
 * already available to all staff on this page, while Settings is admin-only.
 * Putting the paste box behind that gate meant an ops user could add orders one
 * tick at a time but not hand over a list — which is the whole point of it.
 *
 * Resolution happens server-side against `orders.order_name`; anything we don't
 * hold is reported back rather than silently dropped. See
 * app/api/orders/worklist/route.ts. */
export default function AddByNumber() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Client-side preview of what the server will parse, so the button can say
  // how many it's about to add before anything is sent.
  const parsed = parseOrderNames(text);

  const submit = async () => {
    if (!parsed.length) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/orders/worklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNames: text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? "Failed to add to the working set.");
        return;
      }
      // Report what actually happened, including what could NOT be resolved — a
      // paste where half the numbers aren't in the database yet must not read as
      // a clean success.
      const parts: string[] = [];
      if (body.count) parts.push(`${body.count} added`);
      if (body.notFound?.length) {
        parts.push(`${body.notFound.length} not found (${body.notFound.join(", ")}) — not pulled from Shopify yet`);
      }
      setMsg(parts.join(" · ") || "Nothing to do.");
      if (body.count) setText("");
      router.refresh();
    } catch {
      setErr("Network error — please retry.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
        title="Paste a list of order numbers to work — union'd with the tags in Settings"
      >
        ＋ Add orders by number
      </button>
    );
  }

  return (
    <div
      className="card"
      style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: ".9rem" }}>Add orders to the working set</strong>
        <button
          type="button"
          onClick={() => { setOpen(false); setMsg(null); setErr(null); }}
          className="rounded-md border border-line-strong px-2 py-1 text-sm text-ink-soft hover:text-ink"
        >
          Close
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        rows={3}
        autoFocus
        placeholder="#2000018, #2000026"
        aria-label="Order numbers to add to the working set"
        style={{
          width: "100%", padding: "8px 10px", borderRadius: 8, font: "inherit",
          fontFamily: "var(--mono)", fontSize: ".85rem",
          border: "1px solid var(--line-strong)", background: "var(--surface)", color: "var(--ink)",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={busy || !parsed.length}
          onClick={submit}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-ink disabled:opacity-50"
        >
          {busy ? "Adding…" : parsed.length ? `Add ${parsed.length} to working set` : "Add to working set"}
        </button>
        <span style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>
          Commas, spaces or one per line. The <code>#</code> is optional.
        </span>
      </div>

      {msg && <p role="status" style={{ fontSize: ".82rem", color: "var(--ink)", margin: 0 }}>{msg}</p>}
      {err && <p role="alert" style={{ fontSize: ".82rem", color: "var(--crit)", margin: 0 }}>{err}</p>}
    </div>
  );
}
