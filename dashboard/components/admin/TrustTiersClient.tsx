"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TrustTier } from "@/lib/types";
import Button from "@/components/ui/Button";

export default function TrustTiersClient({ tiers }: { tiers: TrustTier[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(tiers);
  const [busy, setBusy] = useState<string | null>(null);

  function edit(code: string, patch: Partial<TrustTier>) {
    setRows((r) => r.map((t) => (t.code === code ? { ...t, ...patch } : t)));
  }
  async function save(t: TrustTier) {
    setBusy(t.code);
    try {
      const res = await fetch("/api/trust-tiers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) });
      if (!res.ok) alert((await res.json()).error ?? "Failed"); else router.refresh();
    } finally { setBusy(null); }
  }

  return (
    <main className="ds page">
      <p className="eyebrow">Admin</p>
      <h1>Trust tiers</h1>
      <p style={{ color: "var(--ink-soft)", fontSize: ".9rem", margin: "6px 0 16px" }}>Split % per tier + photo-required. Manual tier assignment for now.</p>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="data-table">
          <thead><tr><th>Tier</th><th>On accept %</th><th>On delivery %</th><th>Photo</th><th>Hold</th><th>Cap €</th><th></th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.code} className={`row-tier-${t.code.toLowerCase()}`}>
                <td><b>{t.code}</b> · {t.label}</td>
                <td><input type="number" value={t.split_on_accept} onChange={(e) => edit(t.code, { split_on_accept: +e.target.value })} style={inp} /></td>
                <td><input type="number" value={t.split_on_delivery} onChange={(e) => edit(t.code, { split_on_delivery: +e.target.value })} style={inp} /></td>
                <td><input type="checkbox" checked={t.photo_required} onChange={(e) => edit(t.code, { photo_required: e.target.checked })} /></td>
                <td><input type="checkbox" checked={t.hold_payout} onChange={(e) => edit(t.code, { hold_payout: e.target.checked })} /></td>
                <td><input type="number" value={t.exposure_cap_eur ?? ""} onChange={(e) => edit(t.code, { exposure_cap_eur: e.target.value === "" ? null : +e.target.value })} style={inp} /></td>
                <td><Button variant="solid" disabled={busy !== null} onClick={() => save(t)}>Save</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
const inp: React.CSSProperties = { width: 64, padding: "4px 6px", border: "1px solid var(--line-strong)", borderRadius: 6, background: "var(--surface-2)", color: "var(--ink)" };
