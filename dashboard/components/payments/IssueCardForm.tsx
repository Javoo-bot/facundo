"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";

export interface IssueCardFormProps {
  /** Fixed florist — locked, no picker shown (the florist-profile-page entry point). */
  florist?: { id: string; name: string };
  /** Full florist list — shown as a searchable picker when `florist` is not set
   *  (the payments-page entry point). */
  floristOptions?: { id: string; name: string }[];
  /** Called after a successful issue (e.g. to close a modal/collapse the form). */
  onDone?: () => void;
}

// Admin-only ad-hoc card issuance — EUR only, mandatory reason. Self-contained:
// does its own fetch + refresh, so it can be dropped into any admin surface.
// The caller is responsible for only rendering this for staffRole === 'admin'.
export default function IssueCardForm({ florist, floristOptions, onDone }: IssueCardFormProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(florist?.id ?? null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  // Real money leaves the account on submit, so "Issue card" only validates and
  // asks; the confirmed amount/florist are what actually get posted. Same inline
  // two-step pattern as the close-card confirm in StaffCardActions.tsx.
  const [confirm, setConfirm] = useState<{ floristId: string; amount: number; name: string | null } | null>(null);

  const matches = useMemo(() => {
    if (florist || !floristOptions || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    return floristOptions.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
  }, [florist, floristOptions, query]);

  const pickedName = florist?.name ?? floristOptions?.find((f) => f.id === pickedId)?.name ?? null;

  // Step 1: validate, then ask. Nothing is posted from here.
  function review() {
    setErr(null);
    setOk(null);
    const floristId = florist?.id ?? pickedId;
    const parsed = Number(amount);
    if (!floristId) { setErr("Pick a florist."); return; }
    if (!Number.isFinite(parsed) || parsed <= 0) { setErr("Enter a valid amount."); return; }
    if (!reason.trim()) { setErr("A reason is required."); return; }
    // Cents precision — a card is issued in minor units, so don't let a stray
    // 12.345 be confirmed as one number and issued as another.
    setConfirm({ floristId, amount: Math.round(parsed * 100) / 100, name: pickedName });
  }

  // Step 2: the human said yes — issue exactly what they confirmed.
  async function submit() {
    if (!confirm) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/payouts/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floristId: confirm.floristId, amount: confirm.amount, reason: reason.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setErr(j.error ?? "Couldn't issue the card.");
        setConfirm(null);
        return;
      }
      setOk(`Issued ${j.amount} ${j.currency}.`);
      setAmount("");
      setReason("");
      setConfirm(null);
      // Reset the picker too, so a second issue can't silently land on the
      // florist selected for the first one (picker-mode entry point only —
      // `florist` prop mode stays locked to its fixed florist).
      if (!florist) { setPickedId(null); setQuery(""); }
      router.refresh();
      onDone?.();
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {!florist && (
        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>Florist</label>
          {pickedName ? (
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <b>{pickedName}</b>
              <button type="button" className="link-subtle" onClick={() => { setPickedId(null); setQuery(""); setConfirm(null); }}>Change</button>
            </span>
          ) : (
            <>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search florists by name…"
                style={inputStyle}
              />
              {matches.length > 0 && (
                <div className="ocard" style={{ padding: 4, display: "grid" }}>
                  {matches.map((f) => (
                    <button key={f.id} type="button" className="link-subtle" style={{ textAlign: "left", padding: "4px 8px" }} onClick={() => { setPickedId(f.id); setQuery(""); }}>
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div style={{ display: "grid", gap: 4 }}>
        <label style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>Amount (EUR)</label>
        <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => { setAmount(e.target.value); setConfirm(null); }} style={inputStyle} />
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <label style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>Reason (recorded on the payout)</label>
        <input value={reason} onChange={(e) => { setReason(e.target.value); setConfirm(null); }} placeholder="e.g. goodwill gesture — order #1234 delayed" style={inputStyle} />
      </div>
      {confirm ? (
        <div style={{ fontSize: ".85rem", display: "grid", gap: 6 }}>
          <span>Issue a €{confirm.amount.toFixed(2)} card to <b>{confirm.name ?? "this florist"}</b>?</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="solid" disabled={busy} onClick={submit}>{busy ? "Issuing…" : "Yes, issue"}</Button>
            <button type="button" className="link-subtle" disabled={busy} onClick={() => setConfirm(null)}>No</button>
          </span>
        </div>
      ) : (
        <div>
          <Button variant="solid" disabled={busy} onClick={review}>Issue card</Button>
        </div>
      )}
      {err && <span style={{ color: "var(--crit)", fontSize: ".8rem" }}>{err}</span>}
      {ok && <span style={{ color: "var(--ink-soft)", fontSize: ".8rem" }}>{ok}</span>}
    </div>
  );
}

const inputStyle: React.CSSProperties = { padding: "6px 8px", fontSize: ".85rem", border: "1px solid var(--line)", borderRadius: 6 };
