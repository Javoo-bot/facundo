"use client";
import { useState } from "react";
import Button from "@/components/ui/Button";

// On-demand read-through to Airwallex for this payout's card, shown next to
// what we stored. Read-only: it changes nothing, so there's no router.refresh()
// — the point is to reveal that the stored row is stale, not to fix it.

interface Row {
  id: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  merchant: string | null;
  authCode: string | null;
}
interface TxnRow extends Row {
  type: string | null;
  postedAt: string | null;
}
interface AuthRow extends Row {
  createdAt: string | null;
}
interface Drift {
  field: string;
  stored: string;
  live: string;
  note: string;
}
interface Live {
  cardStatus: string | null;
  currency: string | null;
  clearedTotal: number | null;
  pendingTotal: number | null;
  spent: boolean;
  transactions: TxnRow[];
  authorizations: AuthRow[];
  drift: Drift[];
  partial: string[];
  fetchedAt: string;
}

function money(a: number | null, ccy: string | null): string {
  if (a == null) return "—";
  return ccy ? `${a.toFixed(2)} ${ccy}` : a.toFixed(2);
}
function dt(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function LiveAirwallexPanel({ payoutId }: { payoutId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);

  async function load() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/payouts/${payoutId}/live`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error ?? "Could not load live data.");
        return;
      }
      setLive(j as Live);
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Button disabled={busy} onClick={load}>
          {busy ? "Querying…" : live ? "Re-query Airwallex" : "Query live from Airwallex"}
        </Button>
        {live && (
          <span style={{ fontSize: ".72rem", color: "var(--muted)" }}>as of {dt(live.fetchedAt)}</span>
        )}
      </div>
      {err && <span style={{ color: "var(--crit)", fontSize: ".72rem" }}>{err}</span>}

      {live && (
        <>
          {live.partial.length > 0 && (
            <div className="badge badge-warn" style={{ display: "block", padding: "8px 10px", lineHeight: 1.5 }}>
              Airwallex didn&apos;t answer for: {live.partial.join(", ")}. This view is incomplete — treat any
              comparison below as unconfirmed.
            </div>
          )}

          {live.drift.length > 0 ? (
            <div
              style={{
                border: "1px solid var(--crit)",
                borderRadius: 8,
                padding: "10px 12px",
                display: "grid",
                gap: 8,
              }}
            >
              <strong style={{ fontSize: ".8rem", color: "var(--crit)" }}>
                Stored record disagrees with Airwallex
              </strong>
              {live.drift.map((d) => (
                <div key={d.field} style={{ fontSize: ".76rem", lineHeight: 1.5 }}>
                  <code>{d.field}</code>: stored <strong>{d.stored}</strong> · live <strong>{d.live}</strong>
                  <div style={{ color: "var(--muted)" }}>{d.note}</div>
                </div>
              ))}
              <div style={{ fontSize: ".72rem", color: "var(--muted)" }}>
                Nothing was written. These columns are only ever set by the Airwallex webhook, so persistent drift
                means webhook delivery needs fixing.
              </div>
            </div>
          ) : (
            <div style={{ fontSize: ".76rem", color: "var(--muted)" }}>
              Stored record matches Airwallex.
            </div>
          )}

          <dl className="kv">
            <dt>Live card status</dt>
            <dd>{live.cardStatus ?? "—"}</dd>
            <dt>Cleared</dt>
            <dd>{money(live.clearedTotal, live.currency)}</dd>
            <dt>Pending</dt>
            <dd>{money(live.pendingTotal, live.currency)}</dd>
          </dl>

          <div>
            <div className="mini-h" style={{ marginBottom: 6 }}>Transactions ({live.transactions.length})</div>
            {live.transactions.length === 0 ? (
              <div style={{ fontSize: ".76rem", color: "var(--muted)" }}>None — this card has never been charged.</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {live.transactions.map((t, i) => (
                  <div key={t.id ?? i} style={{ fontSize: ".76rem", lineHeight: 1.5 }}>
                    <strong>{money(t.amount, t.currency)}</strong> · {t.merchant ?? "—"} · {t.type} · {t.status}
                    <div style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: ".7rem" }}>
                      {dt(t.postedAt)} · auth {t.authCode ?? "—"} · {t.id ?? "—"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mini-h" style={{ marginBottom: 6 }}>Authorizations ({live.authorizations.length})</div>
            {live.authorizations.length === 0 ? (
              <div style={{ fontSize: ".76rem", color: "var(--muted)" }}>None.</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {live.authorizations.map((a, i) => (
                  <div key={a.id ?? i} style={{ fontSize: ".76rem", lineHeight: 1.5 }}>
                    <strong>{money(a.amount, a.currency)}</strong> · {a.merchant ?? "—"} · {a.status}
                    <div style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: ".7rem" }}>
                      {dt(a.createdAt)} · auth {a.authCode ?? "—"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
