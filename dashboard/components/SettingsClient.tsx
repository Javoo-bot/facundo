"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import SimpleToast from "@/components/SimpleToast";
import AccessPanel from "@/components/settings/AccessPanel";
import PersonasPanel from "@/components/settings/PersonasPanel";
import GeneralPanel from "@/components/settings/GeneralPanel";
import IntegrationsPanel from "@/components/settings/IntegrationsPanel";
import MatchingPanel from "@/components/settings/MatchingPanel";
import NotificationsPanel, { type CxPushState } from "@/components/settings/NotificationsPanel";
import OffersPanel from "@/components/settings/OffersPanel";
import OutreachPanel from "@/components/settings/OutreachPanel";
import PaymentsPanel from "@/components/settings/PaymentsPanel";
import SettingsTabs, { parseTab, type SettingsTabId } from "@/components/settings/SettingsTabs";
import { initialForm, type SetField, type SettingsForm } from "@/components/settings/types";
import { useToasts } from "@/lib/useToasts";
import { enableStaffPush } from "@/lib/pushClient";
import type { AppSettings } from "@/lib/types";
import type { StaffRole } from "@/lib/staffRoles";

// Client-side sanity check only — not the security boundary. The server
// route (app/api/allowlist/route.ts) re-validates with its own regex before
// touching the DB, so this just catches obvious typos before a round-trip.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Settings, split across seven tabs (see components/settings/*Panel.tsx). This
 * component owns all the state; the panels are presentational. Keeping the form
 * hoisted here means switching tabs never drops an edit and one Save still
 * writes every field, regardless of which tab you happen to be on.
 */
export default function SettingsClient({
  initial,
  userEmail,
  allowedEmails,
}: {
  initial: AppSettings | null;
  userEmail: string;
  allowedEmails: { email: string; role: StaffRole }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [form, setForm] = useState<SettingsForm>(() => initialForm(initial));
  const set = useCallback<SetField>((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  // The active tab lives in the URL so a tab is linkable and survives the
  // router.refresh() that follows an allow-list edit.
  const tab = parseTab(searchParams.get("tab"));
  const selectTab = useCallback(
    (next: SettingsTabId) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "general") params.delete("tab");
      else params.set("tab", next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const [saving, setSaving] = useState(false);
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState<{ ok: boolean; to?: string; error?: string } | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<StaffRole>("ops");
  const [addingEmail, setAddingEmail] = useState(false);
  const [removingEmail, setRemovingEmail] = useState<string | null>(null);
  const [changingRole, setChangingRole] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToasts();

  // CX alert push — dashboard/lib/cxAlerts.ts pages subscribed staff devices
  // when SLA-breaching work goes unattended (email always fires to cx_email;
  // push is this device opting in additionally). Browser-only APIs, so state
  // starts "off" and is corrected after mount.
  const [cxPushState, setCxPushState] = useState<CxPushState>("off");
  const [cxPushError, setCxPushError] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setCxPushState("unsupported");
      return;
    }
    setCxPushState(Notification.permission === "granted" ? "on" : "off");
  }, []);
  const handleEnableCxPush = async () => {
    setCxPushState("requesting");
    setCxPushError(null);
    const result = await enableStaffPush();
    if (result.ok) {
      setCxPushState("on");
      push("success", "CX alert push enabled on this device.");
    } else {
      setCxPushState("error");
      setCxPushError(result.error ?? "Could not enable notifications.");
    }
  };

  const addEmail = async () => {
    const trimmed = newEmail.trim();
    if (!EMAIL_RE.test(trimmed)) {
      push("error", "Enter a valid email address.");
      return;
    }
    setAddingEmail(true);
    try {
      const res = await fetch("/api/allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, role: newRole }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        push("error", j.error || `Failed to add email (${res.status}).`);
      } else {
        setNewEmail("");
        push("success", `${trimmed} can now sign in.`);
        router.refresh();
      }
    } finally {
      setAddingEmail(false);
    }
  };

  const changeRole = async (email: string, role: StaffRole) => {
    setChangingRole(email);
    try {
      const res = await fetch("/api/allowlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        push("error", j.error || `Failed to update role (${res.status}).`);
      } else {
        push("success", `${email} is now ${role}.`);
        router.refresh();
      }
    } finally {
      setChangingRole(null);
    }
  };

  const removeEmail = async (email: string) => {
    setRemovingEmail(email);
    try {
      const res = await fetch("/api/allowlist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        push("error", j.error || `Failed to remove email (${res.status}).`);
      } else {
        push("success", `${email} removed.`);
        router.refresh();
      }
    } finally {
      setRemovingEmail(null);
    }
  };

  const sendTestEmail = async () => {
    setSendingTestEmail(true);
    setTestEmailResult(null);
    try {
      const res = await fetch("/api/settings/test-email", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        const error = j.error || `Send failed (${res.status}).`;
        setTestEmailResult({ ok: false, error });
        push("error", error);
      } else {
        setTestEmailResult({ ok: true, to: j.to });
        push("success", `Test email sent to ${j.to}.`);
      }
    } catch {
      const error = "Send failed — network error.";
      setTestEmailResult({ ok: false, error });
      push("error", error);
    } finally {
      setSendingTestEmail(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          test_mode: form.test_mode,
          test_email: form.test_email || null,
          test_phone: form.test_phone || null,
          workflow_mode: form.workflow_mode,
          test_shop_matching: form.test_shop_matching,
          cx_email: form.cx_email || null,
          florist_support_email: form.florist_support_email || null,
          payments_paused: form.payments_paused,
          hold_delivery_payouts: form.hold_delivery_payouts,
          shopify_writeback_enabled: form.shopify_writeback_enabled,
          default_payout_percent: form.default_payout_percent,
          active_order_tags: form.activeOrderTagsText.split(",").map((t) => t.trim()).filter(Boolean),
          active_order_countries: form.activeOrderCountriesText.split(",").map((c) => c.trim()).filter(Boolean),
          run_all_orders: form.run_all_orders,
          working_set_radius_km: form.working_set_radius_km,
          message_voice: form.message_voice,
          email_offer_enabled: form.email_offer_enabled,
          email_accept_confirm_enabled: form.email_accept_confirm_enabled,
          email_client_assigned_enabled: form.email_client_assigned_enabled,
          email_client_on_the_way_enabled: form.email_client_on_the_way_enabled,
          email_client_delivered_enabled: form.email_client_delivered_enabled,
          email_issue_to_florist_enabled: form.email_issue_to_florist_enabled,
          email_issue_to_cx_enabled: form.email_issue_to_cx_enabled,
          email_cx_alert_enabled: form.email_cx_alert_enabled,
          email_recruiting_enabled: form.email_recruiting_enabled,
          offer_parallel_sends: form.offer_parallel_sends,
          offer_window_rush_min: form.offer_window_rush_min,
          offer_window_sameday_min: form.offer_window_sameday_min,
          offer_window_standard_min: form.offer_window_standard_min,
          offer_window_far_min: form.offer_window_far_min,
          offer_window_nodate_min: form.offer_window_nodate_min,
          late_accept_buffer_hours: form.late_accept_buffer_hours,
          cx_reserve_hours: form.cx_reserve_hours,
          operator_view: form.operator_view,
          sms_offer_enabled: form.sms_offer_enabled,
          sms_recruiting_enabled: form.sms_recruiting_enabled,
          sms_accept_confirm_enabled: form.sms_accept_confirm_enabled,
          stats_chat_model: form.stats_chat_model,
          sequence_enabled: form.sequence_enabled,
          sequence_auto_enrol_scraped: form.sequence_auto_enrol_scraped,
          sequence_min_gap_hours: form.sequence_min_gap_hours,
          sequence_daily_send_cap: form.sequence_daily_send_cap,
          cold_offer_enabled: form.cold_offer_enabled,
          cold_offer_max_payout_eur: form.cold_offer_max_payout_eur,
          cold_offer_auto_payout_cap_eur: form.cold_offer_auto_payout_cap_eur,
          cold_offer_default_radius_km: form.cold_offer_default_radius_km,
          cx_agent_enabled: form.cx_agent_enabled,
          support_agent_enabled: form.support_agent_enabled,
          florist_chat_enabled: form.florist_chat_enabled,
          cx_agent_min_confidence: form.cx_agent_min_confidence,
          cx_agent_max_auto_turns: form.cx_agent_max_auto_turns,
          // Matching. Ring edges are typed as "5, 10, 20" and parsed here; the
          // server re-validates (ascending, positive) and ignores a bad ladder
          // rather than half-applying it.
          match_ring_edges_km: form.matchRingEdgesText
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n)),
          match_weight_distance: form.match_weight_distance,
          match_weight_onboarded: form.match_weight_onboarded,
          match_weight_emailable: form.match_weight_emailable,
          match_weight_quality: form.match_weight_quality,
          match_weight_source: form.match_weight_source,
          match_weight_tier: form.match_weight_tier,
          match_weight_performance: form.match_weight_performance,
          match_top_n: form.match_top_n,
          match_max_waves: form.match_max_waves,
          // "" means "no floor" — deliberately null, not 0.
          match_min_rating: form.match_min_rating.trim() === "" ? null : Number(form.match_min_rating),
          match_min_review_count: form.match_min_review_count.trim() === "" ? null : Number(form.match_min_review_count),
          match_allow_unrated: form.match_allow_unrated,
          match_exclude_tier4: form.match_exclude_tier4,
          match_require_trust_tier: form.match_require_trust_tier,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        push("error", j.error || `Save failed (${res.status}).`);
      } else {
        push("success", "Settings saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  function renderPanel() {
    switch (tab) {
      case "matching":
        return <MatchingPanel form={form} set={set} />;
      case "offers":
        return <OffersPanel form={form} set={set} />;
      case "payments":
        return <PaymentsPanel form={form} set={set} />;
      case "notifications":
        return (
          <NotificationsPanel
            form={form}
            set={set}
            cxPushState={cxPushState}
            cxPushError={cxPushError}
            onEnableCxPush={handleEnableCxPush}
            sendingTestEmail={sendingTestEmail}
            testEmailResult={testEmailResult}
            onSendTestEmail={sendTestEmail}
          />
        );
      case "outreach":
        return <OutreachPanel form={form} set={set} />;
      case "integrations":
        return <IntegrationsPanel form={form} set={set} />;
      case "personas":
        return <PersonasPanel />;
      case "access":
        return (
          <AccessPanel
            allowedEmails={allowedEmails}
            userEmail={userEmail}
            newEmail={newEmail}
            setNewEmail={setNewEmail}
            newRole={newRole}
            setNewRole={setNewRole}
            addingEmail={addingEmail}
            removingEmail={removingEmail}
            changingRole={changingRole}
            onAdd={addEmail}
            onChangeRole={changeRole}
            onRemove={removeEmail}
          />
        );
      default:
        return <GeneralPanel form={form} set={set} />;
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <p className="eyebrow">Backoffice</p>
      <h1>Settings</h1>

      {/* Pinned above the tabs: this reports global state, not a General-tab
          detail, so it stays visible whichever tab you're on. */}
      <div
        className={`mt-6 rounded-lg border p-4 text-sm ${form.test_mode ? "text-warn" : "text-crit"}`}
        style={{
          borderColor: `color-mix(in srgb, var(${form.test_mode ? "--warn" : "--crit"}) 45%, var(--line))`,
          background: `color-mix(in srgb, var(${form.test_mode ? "--warn" : "--crit"}) 12%, transparent)`,
        }}
      >
        {form.test_mode
          ? "🧪 Test mode ON — every outreach email is redirected to the test address under General. Real florists are never contacted."
          : "🔴 Test mode OFF (LIVE) — outreach emails go to the real florists."}
      </div>

      <div className="mt-6">
        <SettingsTabs active={tab} onChange={selectTab} />
      </div>

      <div
        className="mt-5"
        role="tabpanel"
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
      >
        {renderPanel()}
      </div>

      {/* Access and Personas edits apply immediately (they write their own
          rows through their own routes), so the batch Save button would only
          imply their changes are pending. Every other tab shares this button. */}
      {tab !== "access" && tab !== "personas" && (
        <div className="mt-8 flex items-center gap-3 border-t border-line pt-5">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-ink disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
          <span className="text-xs text-ink-faint">Saves every tab, not just this one.</span>
        </div>
      )}

      <SimpleToast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
