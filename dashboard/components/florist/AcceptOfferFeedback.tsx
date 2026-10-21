"use client";

import type { AcceptResult } from "./useAcceptOffer";
import { useT } from "@/components/florist/LocaleProvider";

/** Inline confirmation/error state for the accept-offer flow — replaces
 * `alert()`. Renders nothing while idle/busy (the caller shows its own busy
 * state on the trigger button). */
export default function AcceptOfferFeedback({ result }: { result: AcceptResult }) {
  const { t } = useT();
  if (result.kind === "success") {
    return (
      <div className="ocard" style={{ borderColor: "var(--accent)", color: "var(--ink)" }} role="status">
        {t("ui.offer.feedback.success")}
      </div>
    );
  }
  if (result.kind === "taken") {
    return (
      <div className="ocard" role="status">
        {t("ui.offer.feedback.taken")}
      </div>
    );
  }
  if (result.kind === "error") {
    return (
      <div style={{ color: "var(--crit)", fontSize: ".82rem" }} role="alert">
        {result.message}
      </div>
    );
  }
  return null;
}
