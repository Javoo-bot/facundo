"use client";

import { useT } from "@/components/florist/LocaleProvider";

/** The message the customer wants written on the card.
 *
 * Renders only when there IS one (888 of 1000 sampled orders). With no
 * message the whole block is omitted rather than claiming a blank card ships
 * anyway — we haven't verified that, and the repo rule is to say nothing we
 * can't back up.
 *
 * Messages are frequently multi-line prose, so `white-space: pre-line` is
 * load-bearing, not decoration. */
export default function OfferCardMessage({ greeting }: { greeting: string | null }) {
  const { t } = useT();
  const text = (greeting ?? "").trim();
  if (!text) return null;
  return (
    <div className="ocard" style={{ display: "grid", gap: 8 }}>
      <div className="fc-offer-h">{t("ui.offer.page.cardTitle")}</div>
      <div style={{ fontSize: ".9rem", color: "var(--ink-soft)" }}>{t("ui.offer.page.cardInstruction")}</div>
      <blockquote
        style={{
          margin: 0,
          padding: "10px 12px",
          borderLeft: "3px solid var(--line)",
          background: "var(--surface-2)",
          borderRadius: 8,
          whiteSpace: "pre-line",
          fontSize: "1.02rem",
          lineHeight: 1.5,
        }}
      >
        {text}
      </blockquote>
    </div>
  );
}
