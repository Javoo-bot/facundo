"use client";

import Link from "next/link";
import { GroupLabel, Hint, PanelCard, Toggle } from "@/components/settings/fields";
import type { EmailVoice } from "@/lib/messageVoice";

/**
 * The email kinds whose voice is settable, with the `kind` strings
 * lib/messageVoice.ts resolves against. Only florist-facing outreach is here:
 * a transactional client email pretending to be hand-typed would be a lie, not
 * a style, and the CX alert is read by us.
 *
 * A sequence step can still override any of these — see
 * lib/sequences/definitions.ts and resolveVoice.
 */
const VOICE_KINDS: { kind: string; label: string; hint: string; forced?: EmailVoice }[] = [
  { kind: "offer", label: "Offer email", hint: "The order we send a florist in the network." },
  { kind: "recruit.t1", label: "Recruiting 1 — first email", hint: "Day 0, from Facundo." },
  { kind: "recruit.t2", label: "Recruiting 2 — we're short here", hint: "Day 3, from the market's persona.", forced: "plain" },
  { kind: "recruit.t3", label: "Recruiting 3 — how the money works", hint: "Day 7, from the persona.", forced: "plain" },
  { kind: "recruit.r1", label: "Re-engagement 1 — what stopped you?", hint: "Two days after their first click.", forced: "plain" },
  { kind: "recruit.r2", label: "Re-engagement 2 — closing this off", hint: "The graceful exit.", forced: "plain" },
  { kind: "recruit.co1", label: "Cold offer follow-up 1", hint: "After a real order we offered them went elsewhere.", forced: "plain" },
  { kind: "recruit.co2", label: "Cold offer follow-up 2", hint: "Last word on the next order.", forced: "plain" },
];
import type { PanelProps } from "@/components/settings/types";

export type CxPushState = "unsupported" | "off" | "requesting" | "on" | "error";

/**
 * Every outbound channel in one place: the per-type email and SMS toggles, the
 * CX alert push opt-in, the deliverability probe, and the link to the template
 * editor. The probe and the template link used to sit inside the "External
 * services" card next to Shopify write-back, which had nothing to do with them.
 */
export default function NotificationsPanel({
  form,
  set,
  cxPushState,
  cxPushError,
  onEnableCxPush,
  sendingTestEmail,
  testEmailResult,
  onSendTestEmail,
}: PanelProps & {
  cxPushState: CxPushState;
  cxPushError: string | null;
  onEnableCxPush: () => void;
  sendingTestEmail: boolean;
  testEmailResult: { ok: boolean; to?: string; error?: string } | null;
  onSendTestEmail: () => void;
}) {
  return (
    <div className="space-y-5">
      <PanelCard title="Email">
        <Hint>
          Turn individual outbound emails off without touching test mode. The “Send test email” probe below
          always stays available, regardless of these toggles, so deliverability can always be verified.
        </Hint>

        <GroupLabel>Florist</GroupLabel>
        <div className="mt-2 space-y-3">
          <Toggle
            label="Offer email"
            checked={form.email_offer_enabled}
            onChange={(v) => set("email_offer_enabled", v)}
            hint="If off, offers go out by push only."
          />
          <Toggle
            label="Accept confirmation"
            checked={form.email_accept_confirm_enabled}
            onChange={(v) => set("email_accept_confirm_enabled", v)}
            hint="“Thank you for accepting — we trust you to deliver it correctly”, sent the moment a florist takes an order (or CX takes it for them). If off, the accept still goes through silently."
          />
          <Toggle
            label="Issue replies to florist"
            checked={form.email_issue_to_florist_enabled}
            onChange={(v) => set("email_issue_to_florist_enabled", v)}
            hint="Email sent when CX replies to or resolves a florist-reported issue."
          />
        </div>

        <GroupLabel>Client</GroupLabel>
        <div className="mt-2 space-y-3">
          <Toggle
            label="Order assigned"
            checked={form.email_client_assigned_enabled}
            onChange={(v) => set("email_client_assigned_enabled", v)}
          />
          <Toggle
            label="On the way"
            checked={form.email_client_on_the_way_enabled}
            onChange={(v) => set("email_client_on_the_way_enabled", v)}
          />
          <Toggle
            label="Delivered"
            checked={form.email_client_delivered_enabled}
            onChange={(v) => set("email_client_delivered_enabled", v)}
            hint="The three client-facing order notices — each can be turned off individually."
          />
        </div>

        <GroupLabel>Staff / ops</GroupLabel>
        <div className="mt-2 space-y-3">
          <Toggle
            label="Issue notifications to CX"
            checked={form.email_issue_to_cx_enabled}
            onChange={(v) => set("email_issue_to_cx_enabled", v)}
          />
          <div>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={form.email_cx_alert_enabled}
                onChange={(e) => set("email_cx_alert_enabled", e.target.checked)}
              />
              {/* Inverted vs the other toggles: this one is red when OFF, since
                  silencing the stuck-order/money alarm is the dangerous state. */}
              <span
                className="text-sm font-medium"
                style={{ color: form.email_cx_alert_enabled ? "var(--ink)" : "var(--crit)" }}
              >
                CX SLA alert email
              </span>
            </label>
            <Hint>
              ⚠ Safety alert for stuck orders/money — leave on unless testing. (The staff push still fires even
              if this is off.)
            </Hint>
          </div>
          <Toggle
            label="Recruiting/outreach emails"
            checked={form.email_recruiting_enabled}
            onChange={(v) => set("email_recruiting_enabled", v)}
          />
        </div>
      </PanelCard>

      <PanelCard title="Email voice">
        <Hint>
          How each email looks. <strong>Branded</strong> is the Facundo template: logo, card, green
          button. <strong>Plain</strong> looks like one of our team typed it — no logo, no button, just a
          signature. Follow-ups signed by a named person read better plain; a branded template over a
          personal signature gives the game away. The test-mode banner and the legal footer show either way.
        </Hint>
        <div className="mt-3 space-y-2">
          {VOICE_KINDS.map(({ kind, label, hint, forced }) => (
            <div key={kind} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-ink">{label}</p>
                <p className="text-xs text-ink-faint">
                  {hint}
                  {forced && (
                    // Without this the panel lies: it would show "Branded" for a
                    // step the funnel sends plain, because the step-level
                    // override wins over this map (lib/messageVoice.ts::resolveVoice).
                    // Saying so is cheaper than a setting nobody can trust.
                    <>
                      {" "}
                      <span className="text-warn">
                        Always sent {forced} — this step sets its own voice, which wins over the setting below.
                      </span>
                    </>
                  )}
                </p>
              </div>
              <select
                value={forced ?? form.message_voice[kind] ?? "branded"}
                disabled={Boolean(forced)}
                onChange={(e) => set("message_voice", { ...form.message_voice, [kind]: e.target.value })}
                className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-xs disabled:opacity-50"
                aria-label={`${label} voice`}
              >
                <option value="branded">Branded</option>
                <option value="plain">Plain</option>
              </select>
            </div>
          ))}
        </div>
      </PanelCard>

      <PanelCard title="SMS" tone={form.sms_offer_enabled || form.sms_recruiting_enabled || form.sms_accept_confirm_enabled ? "crit" : "normal"}>
        <div className="space-y-3">
          <Toggle
            label="Florist offer SMS"
            checked={form.sms_offer_enabled}
            onChange={(v) => set("sms_offer_enabled", v)}
            danger
            hint={
              form.sms_offer_enabled
                ? "🔴 ON — order offers text the real florist's phone once test mode is off (routed to the test phone under General while test mode is on)."
                : "Safe default: OFF. Offers still go out by email + push only. Both SMS toggles default to off — turn on only once Telnyx is configured and you want live offer texts."
            }
          />
          <Toggle
            label="Accept confirmation SMS"
            checked={form.sms_accept_confirm_enabled}
            onChange={(v) => set("sms_accept_confirm_enabled", v)}
            danger
            hint={
              form.sms_accept_confirm_enabled
                ? "🔴 ON — taking an order texts the real florist's phone once test mode is off (routed to the test phone under General while test mode is on). Two segments per accept."
                : "Safe default: OFF. The accept confirmation still goes out by email. This is a courtesy message, not an actionable one — turn it on only if you want florists to have the confirmation on their phone."
            }
          />
          <Toggle
            label="Recruiting/outreach SMS"
            checked={form.sms_recruiting_enabled}
            onChange={(v) => set("sms_recruiting_enabled", v)}
            danger
            hint={
              form.sms_recruiting_enabled
                ? "🔴 ON — sending an outreach email also texts the prospective florist (routed to the test phone under General while test mode is on). These are shops that have never contacted us; the text always carries an opt-out link."
                : "Safe default: OFF. Outreach goes by email only. Turn on only once Telnyx is configured and you accept sending cold texts to shops that haven't asked to hear from us."
            }
          />
        </div>
      </PanelCard>

      {cxPushState !== "unsupported" && (
        <PanelCard title="CX alerts">
          <Hint>
            When SLA-breaching or high-urgency CX work sits unattended, we page the CX inbox (set under General)
            and push this device.
          </Hint>
          {cxPushState === "on" ? (
            <div className="mt-2 text-sm font-medium" style={{ color: "var(--accent)" }}>
              ✓ Push notifications enabled on this device
            </div>
          ) : (
            <button
              type="button"
              onClick={onEnableCxPush}
              disabled={cxPushState === "requesting"}
              className="mt-2 rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
            >
              {cxPushState === "requesting" ? "Requesting…" : "Enable CX alert push on this device"}
            </button>
          )}
          {cxPushState === "error" && cxPushError && (
            <p className="mt-1 text-xs" style={{ color: "var(--crit)" }}>{cxPushError}</p>
          )}
        </PanelCard>
      )}

      <PanelCard title="Copy & deliverability">
        <div className="text-sm font-medium text-ink">Email copy</div>
        <Hint>
          View and edit every email string across all 5 locales — overrides take effect immediately, no deploy.
        </Hint>
        <Link
          href="/email-templates"
          className="mt-2 inline-block rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
        >
          Open email templates →
        </Link>

        <div className="mt-4 border-t border-line pt-4">
          <div className="text-sm font-medium text-ink">Email deliverability</div>
          <Hint>
            Send a sample of the branded email template to the test email (set under General), to confirm it
            renders and delivers without waiting for a live order.
          </Hint>
          <button
            type="button"
            onClick={onSendTestEmail}
            disabled={sendingTestEmail}
            className="mt-2 rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            {sendingTestEmail ? "Sending…" : "Send test email"}
          </button>
          {testEmailResult && (
            <p className="mt-1 text-xs" style={{ color: testEmailResult.ok ? "var(--accent)" : "var(--crit)" }}>
              {testEmailResult.ok ? `✓ Sent to ${testEmailResult.to}` : testEmailResult.error}
            </p>
          )}
        </div>
      </PanelCard>
    </div>
  );
}
