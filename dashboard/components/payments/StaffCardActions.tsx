"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface Details {
  card_number: string;
  cvv: string;
  expiry_month: number | string;
  expiry_year: number | string;
  name_on_card: string | null;
}

// CX/staff card ops in the Payments ledger: reveal a florist's card (to read it
// to them) and close a card. Reveal details live only in local state; close
// uses an inline two-step confirm (no blocking window.confirm).
export default function StaffCardActions({ payoutId, cardStatus }: { payoutId: string; cardStatus?: string | null }) {
  const router = useRouter();
  const [details, setDetails] = useState<Details | null>(null);
  const [busy, setBusy] = useState<null | "reveal" | "close">(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const closed = cardStatus === "CLOSED";

  async function reveal() {
    setBusy("reveal");
    setErr(null);
    try {
      const r = await fetch(`/api/payouts/${payoutId}/card`, { cache: "no-store" });
      if (!r.ok) {
        setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Reveal failed.");
        return;
      }
      setDetails((await r.json()) as Details);
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(null);
    }
  }

  async function close() {
    setBusy("close");
    setErr(null);
    try {
      const r = await fetch(`/api/payouts/${payoutId}/close`, { method: "POST" });
      if (!r.ok) {
        setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Close failed.");
        return;
      }
      setConfirmClose(false);
      router.refresh();
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 2 }}>
      {closed ? (
        <span className="badge badge-neutral">Card closed</span>
      ) : (
        <>
          {!details && (
            <button type="button" className="link-subtle" disabled={busy !== null} onClick={reveal} style={btn}>
              {busy === "reveal" ? "Revealing…" : "Reveal card"}
            </button>
          )}
          {details && (
            <div className="ocard" style={{ padding: 8, display: "grid", gap: 2, fontSize: ".78rem" }}>
              <code style={{ fontFamily: "var(--mono)" }}>{details.card_number}</code>
              <span>CVV {details.cvv} · exp {details.expiry_month}/{details.expiry_year}</span>
              <button type="button" className="link-subtle" onClick={() => setDetails(null)} style={btn}>Hide</button>
            </div>
          )}
          {confirmClose ? (
            <span style={{ fontSize: ".75rem" }}>
              Close this card?{" "}
              <button type="button" className="link-subtle" onClick={close} disabled={busy !== null} style={btn}>Yes</button>
              {" · "}
              <button type="button" className="link-subtle" onClick={() => setConfirmClose(false)} style={btn}>No</button>
            </span>
          ) : (
            <button type="button" className="link-subtle" onClick={() => setConfirmClose(true)} style={btn}>Close card</button>
          )}
        </>
      )}
      {err && <span style={{ color: "var(--crit)", fontSize: ".72rem" }}>{err}</span>}
    </div>
  );
}

const btn: React.CSSProperties = { background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" };
