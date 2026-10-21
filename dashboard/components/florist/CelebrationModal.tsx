"use client";
import CardReveal from "@/components/florist/CardReveal";
import { useT } from "@/components/florist/LocaleProvider";

export interface Earned {
  amount: number;
  currency: string;
  payoutId: string | null;
  hasCard: boolean;
}

function symbol(currency: string): string {
  switch (currency) {
    case "EUR": return "€";
    case "GBP": return "£";
    case "USD": return "$";
    default: return `${currency} `;
  }
}

// Celebratory dialog shown when a florist's action added money to their balance.
// Dismissible; never blocks the underlying order flow. When a real card was
// issued, "Get your card" reveals it inline (the most direct path to charging it).
export default function CelebrationModal({ earned, onClose }: { earned: Earned; onClose: () => void }) {
  const { t } = useT();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("ui.offer.celebration.ariaLabel")}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div
        className="ocard"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 360, width: "100%", padding: 22, textAlign: "center", display: "grid", gap: 8 }}
      >
        <div style={{ fontSize: 44, lineHeight: 1 }} aria-hidden>🎉</div>
        <div className="eyebrow">{t("ui.offer.celebration.eyebrow")}</div>
        <div style={{ fontSize: "2rem", fontWeight: 800 }}>
          +{symbol(earned.currency)}{earned.amount.toFixed(2)}
        </div>
        <p style={{ color: "var(--ink-soft)", marginTop: -2 }}>{t("ui.offer.celebration.addedToBalance")}</p>

        {earned.hasCard && earned.payoutId ? (
          <div style={{ justifySelf: "center" }}>
            <CardReveal payoutId={earned.payoutId} />
          </div>
        ) : (
          <p style={{ fontSize: ".82rem", color: "var(--ink-faint)" }}>
            {t("ui.offer.celebration.cardComingSoon")}
          </p>
        )}

        <button type="button" className="btn btn-ghost" style={{ justifySelf: "center", marginTop: 4 }} onClick={onClose}>
          {t("ui.offer.celebration.done")}
        </button>
      </div>
    </div>
  );
}
