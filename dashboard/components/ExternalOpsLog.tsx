"use client";
import { useMemo, useState } from "react";

export interface ExternalOpRow {
  id: string;
  provider: string;
  operation: string;
  direction: "in" | "out";
  order_id: string | null;
  ref: string | null;
  ok: boolean | null;
  skipped: boolean;
  status_code: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

const PROVIDERS = ["all", "shopify", "airwallex", "resend"] as const;

function outcome(r: ExternalOpRow): { label: string; cls: string } {
  if (r.skipped) return { label: "skipped", cls: "badge-neutral" };
  if (r.ok === true) return { label: "ok", cls: "badge-accent" };
  if (r.ok === false) return { label: "failed", cls: "badge-crit" };
  return { label: "—", cls: "badge-neutral" };
}

// The SYSTEM → External operations log: every call to Shopify / Airwallex / Resend,
// inbound and outbound, newest first. Read-only; a truthful record of what actually
// hit (or was safeguarded from hitting) an external service.
export default function ExternalOpsLog({ rows }: { rows: ExternalOpRow[] }) {
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>("all");
  const [failedOnly, setFailedOnly] = useState(false);

  const filtered = useMemo(
    () => rows.filter((r) => (provider === "all" || r.provider === provider) && (!failedOnly || r.ok === false)),
    [rows, provider, failedOnly],
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <p className="eyebrow">System</p>
      <h1>External operations</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Every call to an external service — Shopify, Airwallex, Resend — inbound and outbound. Newest first, last 200.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            onClick={() => setProvider(p)}
            className={`filter-trigger${provider === p ? " on" : ""}`}
            style={{ textTransform: "capitalize" }}
          >
            {p}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
          Failures only
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 text-sm text-ink-faint">No operations logged yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--ink-faint)", fontSize: ".72rem", textTransform: "uppercase" }}>
                <th style={{ padding: "6px 8px" }}>When</th>
                <th style={{ padding: "6px 8px" }}>Provider</th>
                <th style={{ padding: "6px 8px" }}>Operation</th>
                <th style={{ padding: "6px 8px" }}>Dir</th>
                <th style={{ padding: "6px 8px" }}>Outcome</th>
                <th style={{ padding: "6px 8px" }}>Ref</th>
                <th style={{ padding: "6px 8px" }}>ms</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const o = outcome(r);
                return (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: "var(--ink-soft)" }}>
                      {new Date(r.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </td>
                    <td style={{ padding: "6px 8px", textTransform: "capitalize" }}>{r.provider}</td>
                    <td style={{ padding: "6px 8px", fontFamily: "var(--mono, monospace)", fontSize: ".8rem" }}>{r.operation}</td>
                    <td style={{ padding: "6px 8px" }}>{r.direction === "in" ? "↓ in" : "↑ out"}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <span className={`badge ${o.cls}`}>{o.label}{r.status_code ? ` ${r.status_code}` : ""}</span>
                      {r.error && <span title={r.error} style={{ color: "var(--crit)", marginLeft: 6, fontSize: ".72rem" }}>⚠</span>}
                    </td>
                    <td style={{ padding: "6px 8px", fontFamily: "var(--mono, monospace)", fontSize: ".72rem", color: "var(--ink-faint)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.ref ?? ""}>
                      {r.order_id ? <a href={`/orders/${r.order_id}`} style={{ color: "var(--accent)" }}>order</a> : r.ref ?? "—"}
                    </td>
                    <td style={{ padding: "6px 8px", color: "var(--ink-faint)" }}>{r.duration_ms ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
