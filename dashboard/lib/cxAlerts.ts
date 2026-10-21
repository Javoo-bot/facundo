import { createServiceClient } from "@/lib/supabaseAdmin";
import { defaultFrom } from "@/lib/emailFrom";
import { gatherAttention } from "@/lib/cxAttention";
import { sendEmail } from "@/lib/email";
import { sendPushToStaff } from "@/lib/push";
import { captureError } from "@/lib/monitor";
import { logCommunication } from "@/lib/communications";
import { isBreaching, hashBreachingSet, ALERT_THROTTLE_MINUTES } from "@/lib/cxAlertRules";
import { emailEnabled } from "@/lib/emailToggles";
import { BACKOFFICE_BASE } from "@/lib/emailLinks";
import { buildCxAlertEmail } from "@/lib/messages/builders";
import { loadOverrides } from "@/lib/messageOverrides";

// The CX single-point-of-failure fix (x-cx-spof in dashboard/lib/lifecycle.ts):
// gatherAttention() shows the work, but nothing pages a human if no one loads
// the page. This runs off a cron poke (POST /api/cx/alert-sweep), decides
// whether the queue has crossed from "needs eyes eventually" into "a human
// must act now" (lib/cxAlertRules.ts — pure, unit-tested), and if so emails +
// web-pushes staff — throttled so a busy queue doesn't re-page every tick.

export { BREACH_URGENCY_THRESHOLD, ALERT_THROTTLE_MINUTES } from "@/lib/cxAlertRules";

const MAX_ITEMS_IN_ALERT = 8;

// The attention-queue link is a staff-backoffice link → backoffice host. It
// points at the Control panel ("/") since /cx was removed on 2026-08-10 — that
// page renders the same gatherAttention() rows this sweep is paging about.
const APP_BASE = BACKOFFICE_BASE;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface CxAlertSweepResult {
  breachingCount: number;
  alerted: boolean;
  reason: "none-breaching" | "throttled" | "sent";
  emailed: boolean;
  pushedTo: number;
}

/** Gathers CX attention, decides whether to page a human, and if so sends an
 * email (to cx_email, or test_email in test mode) + web-push to subscribed
 * staff, recording the throttle state on app_settings. Never throws — a send
 * failure is logged and reflected in the result rather than raised, since
 * this runs off an unattended cron poke where a thrown error just retry-storms
 * next tick instead of surfacing anywhere useful. */
export async function sweepCxAlerts(): Promise<CxAlertSweepResult> {
  const admin = createServiceClient();
  const nowIso = new Date().toISOString();

  const rows = await gatherAttention(admin);
  const breaching = rows.filter((r) => isBreaching(r, nowIso));

  if (breaching.length === 0) {
    // Clear the remembered hash so the NEXT breach — whenever it happens — is
    // always a fresh transition, never mistaken for "same set as last time".
    // The `not is null` guard skips the write once already cleared, so an
    // empty-queue tick (the common case) is read-only.
    await admin.from("app_settings").update({ cx_alert_last_hash: null }).eq("id", 1).not("cx_alert_last_hash", "is", null);
    return { breachingCount: 0, alerted: false, reason: "none-breaching", emailed: false, pushedTo: 0 };
  }

  const { data: settings } = await admin
    .from("app_settings")
    .select("test_mode, test_email, cx_email, cx_alert_last_sent_at, cx_alert_last_hash, email_cx_alert_enabled")
    .eq("id", 1)
    .single();

  const currentHash = hashBreachingSet(breaching);
  const lastHash = settings?.cx_alert_last_hash ?? null;
  const lastSentAtMs = settings?.cx_alert_last_sent_at ? new Date(settings.cx_alert_last_sent_at).getTime() : 0;
  const throttleMs = ALERT_THROTTLE_MINUTES * 60_000;

  const isTransition = currentHash !== lastHash;
  const throttleElapsed = Date.now() - lastSentAtMs >= throttleMs;
  if (!isTransition && !throttleElapsed) {
    return { breachingCount: breaching.length, alerted: false, reason: "throttled", emailed: false, pushedTo: 0 };
  }

  const testMode = settings?.test_mode ?? true;
  // Live recipient: the configured CX/ops inbox, falling back to the env
  // default when the settings row hasn't been filled in yet. Test mode always
  // redirects to the test sink, matching lib/issueComms.ts's convention.
  const to = testMode ? settings?.test_email ?? null : settings?.cx_email || process.env.CX_ALERT_EMAIL || null;

  // Internal + English-only, but the shared email chrome (test banner, footer)
  // is catalog copy and editable like everything else.
  const overrides = await loadOverrides(admin, "en");

  const top = breaching.slice(0, MAX_ITEMS_IN_ALERT);
  const lines = top.map((r) => `- ${r.orderName ?? r.orderId.slice(0, 8)}: ${r.primary.label} (urgency ${Math.round(r.urgency)})`);
  const { subject, html, bodyText: body } = buildCxAlertEmail(overrides, {
    lines,
    more: breaching.length - top.length,
    queueUrl: APP_BASE,
    testMode,
  });

  // Settings → Notifications toggle. This is a safety alert for stuck
  // orders/money — off gates the EMAIL leg only; the staff web-push just
  // below still fires regardless.
  const cxAlertEmailEnabled = emailEnabled(settings, "cx_alert");
  let emailed = false;
  if (!cxAlertEmailEnabled) {
    await logCommunication({
      channel: "email", audience: "cx", kind: "cx_alert", testMode,
      status: "skipped", provider: "resend", error: "disabled-by-settings", actor: "system",
    });
  } else if (to && EMAIL_RE.test(to)) {
    const res = await sendEmail({
      to,
      from: defaultFrom(),
      subject,
      body,
      html,
      context: { operation: "cx_alert_sweep", audience: "cx", kind: "cx_alert", testMode, actor: "system" },
    });
    emailed = res.ok;
  } else {
    // no valid CX/test address configured — skip (mirrors issueComms' skip logging)
    await logCommunication({
      channel: "email", audience: "cx", kind: "cx_alert", testMode,
      status: "skipped", provider: "resend", error: "no-cx-or-test-email", actor: "system",
    });
  }

  let pushedTo = 0;
  try {
    const pushBody = top[0] ? `${top[0].primary.label}: ${top[0].orderName ?? "an order"}` : "The CX queue needs attention.";
    const { attempted } = await sendPushToStaff(
      { title: subject, body: pushBody, url: "/" },
      { audience: "cx", kind: "cx_alert_push", testMode, actor: "system" }
    );
    pushedTo = attempted;
  } catch (e) {
    captureError("cxAlerts.push", e);
  }

  await admin
    .from("app_settings")
    .update({ cx_alert_last_sent_at: new Date().toISOString(), cx_alert_last_hash: currentHash })
    .eq("id", 1);

  return { breachingCount: breaching.length, alerted: true, reason: "sent", emailed, pushedTo };
}
