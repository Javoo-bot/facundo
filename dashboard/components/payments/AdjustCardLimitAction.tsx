"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

// Staff/CX action: raise a still-open single-use payout card's spend limit in
// place, same card, no reissue — for the case where the florist's payment
// processor bills in a different currency and the FX conversion at swipe time
// lands a little over the card's original limit, declining every retry.
// Inline two-step form (no blocking window.confirm), same shape as
// StaffCardActions. Hidden once the card can no longer be adjusted — closed
// by staff (cardStatus "CLOSED"), already spent (cardStatus "USED", set only
// by the Airwallex webhook on settlement), or the payout row itself is past
// issuance (paid/clawed_back/failed). This is only as fresh as those stored
// columns — the server action re-checks the LIVE Airwallex status as the
// authoritative gate, so a stale render here just means a clearer error
// instead of a silent no-op, never a wrongly-allowed adjustment.
export default function AdjustCardLimitAction({
  payoutId,
  currentAmount,
  currency,
  cardStatus,
  payoutStatus,
}: {
  payoutId: string;
  currentAmount: number | null;
  currency: string | null;
  cardStatus?: string | null;
  payoutStatus?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(currentAmount != null ? String(currentAmount) : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (cardStatus === "CLOSED" || cardStatus === "USED") return null;
  if (payoutStatus === "paid" || payoutStatus === "clawed_back" || payoutStatus === "failed") return null;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/payouts/${payoutId}/adjust-limit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: Number(amount), reason }),
      });
      if (!r.ok) {
        setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Adjust failed.");
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {!open ? (
        <button type="button" className="link-subtle" onClick={() => setOpen(true)} style={btn}>
          Adjust card limit
        </button>
      ) : (
        <div className="ocard" style={{ padding: 8, display: "grid", gap: 6, fontSize: ".78rem" }}>
          <label style={{ display: "grid", gap: 2 }}>
            New limit ({currency ?? "EUR"})
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            Reason (required)
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. FX conversion declined at swipe (LIMIT_EXCEEDED), raising to cover it"
              style={inputStyle}
            />
          </label>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              className="link-subtle"
              onClick={submit}
              disabled={busy || !reason.trim() || !amount}
              style={btn}
            >
              {busy ? "Adjusting…" : "Confirm"}
            </button>
            <button type="button" className="link-subtle" onClick={() => setOpen(false)} disabled={busy} style={btn}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <span style={{ color: "var(--crit)", fontSize: ".72rem" }}>{err}</span>}
    </div>
  );
}

const btn: React.CSSProperties = { background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" };
const inputStyle: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 6, padding: "4px 6px", fontSize: ".8rem" };
