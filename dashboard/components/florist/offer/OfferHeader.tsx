"use client";

import TimeGreeting from "@/components/florist/TimeGreeting";
import { useT } from "@/components/florist/LocaleProvider";
import type { GreetingKey } from "@/lib/floristGreeting";

/** Who is being asked, and what for.
 *
 * The greeting is the OWNER's name, never the shop's — "Good evening, Flors
 * Girona" reads like a mail-merge failure. It covers 9 of 14 onboarded
 * florists; the rest get the bare greeting, which is why the name is optional
 * rather than substituted with the shop.
 *
 * "make this delivery" rather than "process this order": *process* is
 * back-office language for work that is actually making and delivering
 * flowers. */
export default function OfferHeader({
  greetingKey,
  ownerName,
  orderName,
}: {
  greetingKey: GreetingKey | null;
  ownerName: string | null;
  orderName: string | null;
}) {
  const { t } = useT();
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <TimeGreeting
        serverKey={greetingKey}
        greetings={{
          morning: t("ui.accept.greeting.morning"),
          afternoon: t("ui.accept.greeting.afternoon"),
          evening: t("ui.accept.greeting.evening"),
          night: t("ui.accept.greeting.night"),
        }}
        name={ownerName}
        namedTemplate={t("ui.accept.greetingNamed")}
        style={{ margin: 0, fontSize: "1.15rem", fontWeight: 750, letterSpacing: "-.01em", color: "var(--ink)" }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <p style={{ margin: 0, fontSize: "1.05rem", color: "var(--ink-soft)" }}>{t("ui.offer.page.lead")}</p>
        {orderName && (
          <span style={{ fontFamily: "var(--mono)", fontSize: ".95rem", fontWeight: 650, color: "var(--ink-soft)", flexShrink: 0 }}>
            {orderName}
          </span>
        )}
      </div>
    </div>
  );
}
