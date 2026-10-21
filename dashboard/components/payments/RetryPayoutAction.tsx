"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";

// Staff-triggered retry for a failed payout (order-driven or manual) — same
// finance+admin gate as every other payout action; the caller only renders
// this when payout.status === 'failed'.
export default function RetryPayoutAction({ payoutId }: { payoutId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/payouts/${payoutId}/retry`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setErr(j.error ?? "Retry failed.");
        return;
      }
      router.refresh();
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <Button variant="solid" disabled={busy} onClick={retry}>
        {busy ? "Retrying…" : "Retry issue"}
      </Button>
      {err && <span style={{ color: "var(--crit)", fontSize: ".72rem" }}>{err}</span>}
    </div>
  );
}
