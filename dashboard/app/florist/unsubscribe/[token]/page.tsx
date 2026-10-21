import { createServiceClient } from "@/lib/supabaseAdmin";
import { isLocale, DEFAULT_LOCALE, t } from "@/lib/i18n";
import { isTestModeUnsubscribeToken } from "@/lib/unsubscribeChannel";
import UnsubscribeActions from "@/components/florist/UnsubscribeActions";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ locale?: string; channel?: string }>;
}) {
  const { token } = await params;
  const { locale: localeParam, channel: channelParam } = await searchParams;
  const locale = isLocale(localeParam) ? localeParam : DEFAULT_LOCALE;
  // Same default-to-email rule as the API route: any link minted before SMS
  // existed has no `channel` param at all and must keep behaving as email.
  const channel = channelParam === "sms" ? "sms" : "email";

  // TEST-MODE PREVIEW. Every test-mode send carries a sentinel token instead of
  // a real florist's, so a staffer reviewing it can never opt a real business
  // out. That sentinel matches no row, so this page used to render a bare
  // "link not found" — which made the opt-out flow impossible to verify before
  // go-live, even though it is the ONLY opt-out mechanism a florist has (there
  // is no inbound STOP webhook). Render the real screen instead, clearly marked
  // and with the actions inert, so what a florist would see is verifiable.
  // Safety is unchanged: no florist row is loaded, and the API route refuses
  // this token outright.
  if (isTestModeUnsubscribeToken(token)) {
    return (
      <main className="ds page fc-readable" style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
        <div className="card" style={{ maxWidth: 420, padding: "28px 24px", textAlign: "center" }}>
          <p
            style={{
              fontSize: ".75rem",
              fontWeight: 600,
              letterSpacing: ".04em",
              textTransform: "uppercase",
              color: "var(--crit)",
              marginBottom: 12,
            }}
          >
            {t(locale, "ui.unsubscribe.previewBanner")}
          </p>
          <h1 style={{ fontSize: "1.2rem" }}>
            {t(locale, channel === "sms" ? "ui.unsubscribe.titleSms" : "ui.unsubscribe.title")}
          </h1>
          <p style={{ color: "var(--ink-soft)", fontSize: ".9rem", marginBottom: 20 }}>
            {t(locale, channel === "sms" ? "ui.unsubscribe.bodySms" : "ui.unsubscribe.body")}
          </p>
          <div style={{ display: "grid", gap: 8, opacity: 0.55, pointerEvents: "none" }} aria-disabled="true">
            <button className="btn" type="button" disabled>
              {t(locale, "ui.unsubscribe.snoozeButton")}
            </button>
            <button className="btn" type="button" disabled>
              {t(locale, "ui.unsubscribe.stopButton")}
            </button>
          </div>
          <p style={{ color: "var(--ink-soft)", fontSize: ".8rem", marginTop: 16 }}>
            {t(locale, "ui.unsubscribe.previewNote")}
          </p>
        </div>
      </main>
    );
  }

  const admin = createServiceClient();
  const { data: florist } = await admin
    .from("florists")
    .select("id, order_emails_opt_out, order_emails_snoozed_until, order_sms_opt_out, order_sms_snoozed_until")
    .eq("unsubscribe_token", token)
    .maybeSingle();

  if (!florist) {
    return (
      <main className="ds page fc-readable" style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
        <div className="card" style={{ maxWidth: 420, padding: "28px 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.2rem" }}>{t(locale, "ui.unsubscribe.notFoundTitle")}</h1>
          <p style={{ color: "var(--ink-soft)", fontSize: ".9rem" }}>{t(locale, "ui.unsubscribe.notFoundBody")}</p>
        </div>
      </main>
    );
  }

  const alreadyStopped = channel === "sms" ? !!florist.order_sms_opt_out : !!florist.order_emails_opt_out;
  const snoozedUntil = channel === "sms" ? florist.order_sms_snoozed_until : florist.order_emails_snoozed_until;
  const alreadySnoozed = snoozedUntil ? new Date(snoozedUntil).getTime() > Date.now() : false;

  return (
    <main className="ds page fc-readable" style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
      <div className="card" style={{ maxWidth: 420, padding: "28px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.2rem" }}>
          {t(locale, channel === "sms" ? "ui.unsubscribe.titleSms" : "ui.unsubscribe.title")}
        </h1>
        <p style={{ color: "var(--ink-soft)", fontSize: ".9rem", marginBottom: 20 }}>
          {t(locale, channel === "sms" ? "ui.unsubscribe.bodySms" : "ui.unsubscribe.body")}
        </p>
        <UnsubscribeActions
          token={token}
          channel={channel}
          alreadyStopped={alreadyStopped}
          alreadySnoozed={alreadySnoozed}
          labels={{
            snooze: t(locale, "ui.unsubscribe.snoozeButton"),
            stop: t(locale, "ui.unsubscribe.stopButton"),
            snoozedConfirm: t(locale, channel === "sms" ? "ui.unsubscribe.snoozedConfirmSms" : "ui.unsubscribe.snoozedConfirm"),
            stoppedConfirm: t(locale, channel === "sms" ? "ui.unsubscribe.stoppedConfirmSms" : "ui.unsubscribe.stoppedConfirm"),
            error: t(locale, "ui.unsubscribe.error"),
          }}
        />
      </div>
    </main>
  );
}
