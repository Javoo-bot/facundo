import type { AppSettings } from "@/lib/types";
import { isEmailVoice } from "@/lib/messageVoice";

/**
 * The editable half of `app_settings` — every field the Save button writes,
 * one-for-one with the body `SettingsClient.save()` POSTs to /api/settings.
 *
 * Two deliberate departures from `AppSettings`:
 *  - `activeOrderTagsText` / `activeOrderCountriesText` are the comma-separated
 *    *edit* forms of `active_order_tags` / `active_order_countries`; they are
 *    split/trimmed on save.
 *  - Nullable string columns are held as `""` while editing and coerced back to
 *    null on save, so the inputs stay controlled.
 *
 * Columns the client never writes (`id`, `cx_alert_last_*`) are absent on
 * purpose — they can't be typo'd into the payload if they don't exist here.
 */
export interface SettingsForm {
  test_mode: boolean;
  test_email: string;
  test_phone: string;
  cx_email: string;
  florist_support_email: string;
  workflow_mode: "manual" | "semi" | "auto";
  test_shop_matching: "exclude" | "only";
  activeOrderTagsText: string;
  activeOrderCountriesText: string;
  run_all_orders: boolean;
  working_set_radius_km: number;
  payments_paused: boolean;
  hold_delivery_payouts: boolean;
  default_payout_percent: number;
  shopify_writeback_enabled: boolean;
  email_offer_enabled: boolean;
  email_accept_confirm_enabled: boolean;
  email_client_assigned_enabled: boolean;
  email_client_on_the_way_enabled: boolean;
  email_client_delivered_enabled: boolean;
  email_issue_to_florist_enabled: boolean;
  email_issue_to_cx_enabled: boolean;
  email_cx_alert_enabled: boolean;
  email_recruiting_enabled: boolean;
  offer_parallel_sends: number;
  offer_window_rush_min: number;
  offer_window_sameday_min: number;
  offer_window_standard_min: number;
  offer_window_far_min: number;
  offer_window_nodate_min: number;
  call_back_gap_rush_min: number;
  call_back_gap_sameday_min: number;
  call_back_gap_standard_min: number;
  call_back_gap_far_min: number;
  call_back_gap_nodate_min: number;
  late_accept_buffer_hours: number;
  cx_reserve_hours: number;
  sms_offer_enabled: boolean;
  sms_recruiting_enabled: boolean;
  sms_accept_confirm_enabled: boolean;
  stats_chat_model: string;
  /** kind -> "branded" | "plain". See lib/messageVoice.ts. Held as a map (not
   * one field per kind) because the kind list grows with every funnel step and
   * /api/settings is a full-form overwrite — see the migration's comment. */
  message_voice: Record<string, string>;
  // MATCHING. `matchRingEdgesText` is the comma-separated *edit* form of
  // match_ring_edges_km (same convention as activeOrderTagsText); it is parsed
  // on save. The quality floors are held as "" while editing and coerced back to
  // null — "" means "no floor", which is a different answer from 0.
  matchRingEdgesText: string;
  match_weight_distance: number;
  match_weight_onboarded: number;
  match_weight_emailable: number;
  match_weight_quality: number;
  match_weight_source: number;
  match_weight_tier: number;
  match_weight_performance: number;
  match_top_n: number;
  match_max_waves: number;
  match_min_rating: string;
  match_min_review_count: string;
  match_allow_unrated: boolean;
  match_exclude_tier4: boolean;
  match_require_trust_tier: boolean;
  // OUTREACH. Every switch fails closed; see components/settings/OutreachPanel.tsx.
  operator_view: boolean;
  sequence_enabled: boolean;
  sequence_auto_enrol_scraped: boolean;
  sequence_min_gap_hours: number;
  /** null = NO daily ceiling. 0 = send nothing (kill switch). See
   * supabase/migrations/2026-09-10-uncapped-recruiting-sends.sql. */
  sequence_daily_send_cap: number | null;
  cold_offer_enabled: boolean;
  cold_offer_max_payout_eur: number;
  cold_offer_auto_payout_cap_eur: number;
  cold_offer_default_radius_km: number;
  cx_agent_enabled: boolean;
  support_agent_enabled: boolean;
  florist_chat_enabled: boolean;
  cx_agent_min_confidence: number;
  cx_agent_max_auto_turns: number;
}

/** Typed field setter handed to every panel — `set("test_mode", true)`. */
export type SetField = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => void;

/** What every settings panel receives. Panels needing more extend this. */
export interface PanelProps {
  form: SettingsForm;
  set: SetField;
}

/**
 * Seed the form from the singleton `app_settings` row. Every `??` fallback here
 * matches the column default in supabase/migrations — a first-run row that
 * predates a migration reads as the same value the server would coerce it to.
 */
export function initialForm(initial: AppSettings | null): SettingsForm {
  return {
    test_mode: initial?.test_mode ?? true,
    test_email: initial?.test_email ?? "",
    test_phone: initial?.test_phone ?? "",
    cx_email: initial?.cx_email ?? "",
    florist_support_email: initial?.florist_support_email ?? "",
    workflow_mode: initial?.workflow_mode ?? "manual",
    // Anything not exactly "only" is the safe mode, mirroring the server-side
    // coercion in app/api/settings/route.ts.
    test_shop_matching: initial?.test_shop_matching === "only" ? "only" : "exclude",
    activeOrderTagsText: (initial?.active_order_tags ?? []).join(", "),
    activeOrderCountriesText: (initial?.active_order_countries ?? []).join(", "),
    run_all_orders: initial?.run_all_orders ?? false,
    working_set_radius_km: initial?.working_set_radius_km ?? 5,
    payments_paused: initial?.payments_paused ?? false,
    hold_delivery_payouts: initial?.hold_delivery_payouts ?? false,
    default_payout_percent: initial?.default_payout_percent ?? 55,
    shopify_writeback_enabled: initial?.shopify_writeback_enabled ?? false,
    email_offer_enabled: initial?.email_offer_enabled ?? true,
    email_accept_confirm_enabled: initial?.email_accept_confirm_enabled ?? true,
    email_client_assigned_enabled: initial?.email_client_assigned_enabled ?? true,
    email_client_on_the_way_enabled: initial?.email_client_on_the_way_enabled ?? true,
    email_client_delivered_enabled: initial?.email_client_delivered_enabled ?? true,
    email_issue_to_florist_enabled: initial?.email_issue_to_florist_enabled ?? true,
    email_issue_to_cx_enabled: initial?.email_issue_to_cx_enabled ?? true,
    email_cx_alert_enabled: initial?.email_cx_alert_enabled ?? true,
    email_recruiting_enabled: initial?.email_recruiting_enabled ?? true,
    offer_parallel_sends: initial?.offer_parallel_sends ?? 1,
    offer_window_rush_min: initial?.offer_window_rush_min ?? 15,
    offer_window_sameday_min: initial?.offer_window_sameday_min ?? 30,
    offer_window_standard_min: initial?.offer_window_standard_min ?? 60,
    offer_window_far_min: initial?.offer_window_far_min ?? 120,
    offer_window_nodate_min: initial?.offer_window_nodate_min ?? 60,
    call_back_gap_rush_min: initial?.call_back_gap_rush_min ?? 10,
    call_back_gap_sameday_min: initial?.call_back_gap_sameday_min ?? 20,
    call_back_gap_standard_min: initial?.call_back_gap_standard_min ?? 45,
    call_back_gap_far_min: initial?.call_back_gap_far_min ?? 120,
    call_back_gap_nodate_min: initial?.call_back_gap_nodate_min ?? 45,
    late_accept_buffer_hours: initial?.late_accept_buffer_hours ?? 2,
    cx_reserve_hours: initial?.cx_reserve_hours ?? 2,
    // Both SMS toggles fail closed — see lib/smsToggles.ts.
    sms_offer_enabled: initial?.sms_offer_enabled ?? false,
    sms_recruiting_enabled: initial?.sms_recruiting_enabled ?? false,
    sms_accept_confirm_enabled: initial?.sms_accept_confirm_enabled ?? false,
    stats_chat_model: initial?.stats_chat_model ?? "anthropic/claude-sonnet-5",
    // Empty map = every kind resolves to "branded" (lib/messageVoice.ts fails
    // open), which is exactly how every email looks today.
    message_voice: sanitizeVoiceMap(initial?.message_voice),
    // Matching. Every fallback below is DEFAULT_MATCH_CONFIG's value, which is
    // also the migration's column default — so an unmigrated row, a null column
    // and a saved default all render identically.
    matchRingEdgesText: (initial?.match_ring_edges_km ?? [5, 10, 20]).join(", "),
    match_weight_distance: initial?.match_weight_distance ?? 0.25,
    match_weight_onboarded: initial?.match_weight_onboarded ?? 3.0,
    match_weight_emailable: initial?.match_weight_emailable ?? 1.5,
    match_weight_quality: initial?.match_weight_quality ?? 1.0,
    match_weight_source: initial?.match_weight_source ?? 1.2,
    match_weight_tier: initial?.match_weight_tier ?? 1.0,
    match_weight_performance: initial?.match_weight_performance ?? 0.4,
    match_top_n: initial?.match_top_n ?? 3,
    match_max_waves: initial?.match_max_waves ?? 4,
    // "" is the no-floor value, so a null must NOT become "0".
    match_min_rating: initial?.match_min_rating == null ? "" : String(initial.match_min_rating),
    match_min_review_count: initial?.match_min_review_count == null ? "" : String(initial.match_min_review_count),
    match_allow_unrated: initial?.match_allow_unrated ?? true,
    match_exclude_tier4: initial?.match_exclude_tier4 ?? false,
    match_require_trust_tier: initial?.match_require_trust_tier ?? true,
    // Outreach. Every fallback is the migration's column default, so an
    // unmigrated row reads as the value the server would coerce it to. The three
    // booleans default FALSE — nothing in this program sends until asked.
    operator_view: initial?.operator_view ?? false,
    sequence_enabled: initial?.sequence_enabled ?? false,
    sequence_auto_enrol_scraped: initial?.sequence_auto_enrol_scraped ?? false,
    sequence_min_gap_hours: initial?.sequence_min_gap_hours ?? 48,
    // `?? 200` would turn a deliberate "no limit" back into 200 on every
    // page load, so null has to survive the default explicitly.
    sequence_daily_send_cap:
      initial?.sequence_daily_send_cap === null ? null : (initial?.sequence_daily_send_cap ?? 200),
    cold_offer_enabled: initial?.cold_offer_enabled ?? false,
    cold_offer_max_payout_eur: initial?.cold_offer_max_payout_eur ?? 120,
    cold_offer_auto_payout_cap_eur: initial?.cold_offer_auto_payout_cap_eur ?? 90,
    cold_offer_default_radius_km: initial?.cold_offer_default_radius_km ?? 12,
    cx_agent_enabled: initial?.cx_agent_enabled ?? false,
    support_agent_enabled: initial?.support_agent_enabled ?? false,
    // Ships true (matches the migration default): the widget already rendered
    // unconditionally before this flag existed, so an unmigrated/unset row
    // must read as "visible" to avoid silently hiding the chat.
    florist_chat_enabled: initial?.florist_chat_enabled ?? true,
    cx_agent_min_confidence: initial?.cx_agent_min_confidence ?? 0.75,
    cx_agent_max_auto_turns: initial?.cx_agent_max_auto_turns ?? 3,
  };
}

/** Narrow the stored jsonb to the `{kind: voice}` shape the panel edits.
 * Anything unrecognised is dropped rather than round-tripped, so a hand-edited
 * row can't be silently re-saved with a value no send site understands. */
function sanitizeVoiceMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isEmailVoice(value)) out[kind] = value;
  }
  return out;
}
