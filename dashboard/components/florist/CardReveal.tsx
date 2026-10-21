"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/florist/LocaleProvider";

// Fetches sensitive card details on demand and shows them inline. The details
// live only in this component's state — never persisted — and are dropped when
// the florist hides them. Shared by the balance page and the earn-celebration.

export interface CardDetails {
  card_number: string;
  cvv: string;
  expiry_month: number | string;
  expiry_year: number | string;
  name_on_card: string | null;
}

export default function CardReveal({ payoutId, autoOpen = false }: { payoutId: string; autoOpen?: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<CardDetails | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, setOpened] = useState(false);
  const autoFired = useRef(false);

  async function reveal() {
    setBusy(true);
    setErr(null);
    setOpened(true);
    try {
      const res = await fetch(`/api/florist/card/${payoutId}`, { cache: "no-store" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? t("ui.offer.cardReveal.errorGeneric"));
        return;
      }
      setDetails((await res.json()) as CardDetails);
    } catch {
      setErr(t("ui.offer.cardReveal.errorNetwork"));
    } finally {
      setBusy(false);
    }
  }

  // autoOpen kicks the reveal once on mount (used by the celebration modal).
  useEffect(() => {
    if (autoOpen && !autoFired.current) {
      autoFired.current = true;
      void reveal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);

  if (details) {
    return (
      <div className="ocard" style={{ marginTop: 8, padding: 12, display: "grid", gap: 10 }}>
        <Row label={t("ui.offer.cardReveal.cardNumber")} value={details.card_number} mono copyTitle={t("ui.offer.cardReveal.copyCardNumber")} />
        {/* Wrap so CVV + Expires stack instead of overflowing on narrow phones. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <div style={{ flex: "1 1 120px", minWidth: 0 }}><Row label={t("ui.offer.cardReveal.cvv")} value={details.cvv} mono copyTitle={t("ui.offer.cardReveal.copyCvv")} /></div>
          <div style={{ flex: "1 1 120px", minWidth: 0 }}><Row label={t("ui.offer.cardReveal.expires")} value={`${details.expiry_month}/${details.expiry_year}`} copyTitle={t("ui.offer.cardReveal.copyExpires")} /></div>
        </div>
        {details.name_on_card && <Row label={t("ui.offer.cardReveal.name")} value={details.name_on_card} copyTitle={t("ui.offer.cardReveal.copyName")} />}
        <button type="button" className="btn btn-ghost" style={{ justifySelf: "start" }} onClick={() => { setDetails(null); setOpened(false); }}>
          {t("ui.offer.cardReveal.hide")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
      <button type="button" className="btn btn-solid" onClick={reveal} disabled={busy} style={{ justifySelf: "start", minHeight: 44 }}>
        {busy ? t("ui.offer.cardReveal.revealing") : t("ui.offer.cardReveal.getCard")}
      </button>
      {err && <span style={{ color: "var(--crit)", fontSize: ".8rem" }}>{err}</span>}
    </div>
  );
}

function Row({ label, value, mono, copyTitle }: { label: string; value: string; mono?: boolean; copyTitle: string }) {
  const { t } = useT();
  return (
    // Label above value keeps long card numbers from colliding with the label
    // on narrow screens; the value can wrap and the Copy button stays reachable.
    <div style={{ display: "grid", gap: 2 }}>
      <span style={{ color: "var(--ink-faint)", fontSize: ".72rem" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code style={{ fontFamily: mono ? "var(--mono)" : "inherit", fontSize: ".9rem", flex: 1, minWidth: 0, wordBreak: "break-all" }}>{value}</code>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: "4px 8px", fontSize: ".72rem", minHeight: 32, flexShrink: 0 }}
          onClick={() => navigator.clipboard?.writeText(value)}
          title={copyTitle}
        >
          {t("ui.offer.cardReveal.copyButton")}
        </button>
      </div>
    </div>
  );
}
