"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Button from "@/components/ui/Button";

// A held payout leg (70% accept or 30% delivery) awaiting CX release, shown in the
// unified CX desk's Proposed lane alongside the order_approvals previews. Release/reject hit the
// existing finance-gated payout routes (unchanged money paths).
export default function HeldPayoutCard({
  payoutId, leg, amount, currency, floristName, orderId, orderName,
}: {
  payoutId: string; leg: string; amount: number; currency: string;
  floristName: string | null; orderId: string; orderName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/payout/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || `Failed (${res.status}).`);
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const pct = leg === "accept" ? "70%" : "30%";
  return (
    <div className="ocard" style={{ display: "grid", gap: 10, borderColor: "var(--brand, #b1006b)", borderWidth: 1, borderStyle: "solid" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div>
          <div className="mini-h" style={{ color: "var(--brand, #b1006b)" }}>Approval needed · payout{orderName ? ` · ${orderName}` : ""}</div>
          <div style={{ fontWeight: 600 }}>Release the {pct} {leg} leg to {floristName ?? "the florist"}?</div>
        </div>
        <span className="badge badge-neutral">held</span>
      </div>
      <div style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
        {amount.toFixed(2)} {currency} · <Link href={`/orders/${orderId}`} style={{ textDecoration: "underline" }}>review proof on the order →</Link>
      </div>
      {error && <div style={{ color: "var(--crit)", fontSize: ".8rem" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="solid" disabled={busy} onClick={() => act("approve")} style={{ justifyContent: "center" }}>Release payout</Button>
        <Button variant="warn" disabled={busy} onClick={() => act("reject")} style={{ justifyContent: "center" }}>Reject</Button>
      </div>
    </div>
  );
}
