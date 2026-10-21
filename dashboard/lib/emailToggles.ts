// Per-email-type on/off toggles (Settings → Notifications). Pure lookup, no
// I/O — each send site reads its own `app_settings` row (already fetching
// test_mode/test_email etc.) and asks this whether the EMAIL leg should fire.
// See supabase/migrations/2026-07-26-email-toggles.sql for the columns and
// full off-semantics per kind.

export type EmailToggleKind =
  | "offer"
  | "accept_confirm"
  | "client_assigned"
  | "client_on_the_way"
  | "client_delivered"
  | "issue_to_florist"
  | "issue_to_cx"
  | "cx_alert"
  | "recruiting";

// A structural subset of AppSettings — callers pass whatever `.select(...)`
// projection they already fetched; every field is optional/nullable so a
// partial select (or a settings row from before this migration) still works.
export interface EmailToggleSettings {
  email_offer_enabled?: boolean | null;
  email_accept_confirm_enabled?: boolean | null;
  email_client_assigned_enabled?: boolean | null;
  email_client_on_the_way_enabled?: boolean | null;
  email_client_delivered_enabled?: boolean | null;
  email_issue_to_florist_enabled?: boolean | null;
  email_issue_to_cx_enabled?: boolean | null;
  email_cx_alert_enabled?: boolean | null;
  email_recruiting_enabled?: boolean | null;
}

const COLUMN_FOR_KIND: Record<EmailToggleKind, keyof EmailToggleSettings> = {
  offer: "email_offer_enabled",
  accept_confirm: "email_accept_confirm_enabled",
  client_assigned: "email_client_assigned_enabled",
  client_on_the_way: "email_client_on_the_way_enabled",
  client_delivered: "email_client_delivered_enabled",
  issue_to_florist: "email_issue_to_florist_enabled",
  issue_to_cx: "email_issue_to_cx_enabled",
  cx_alert: "email_cx_alert_enabled",
  recruiting: "email_recruiting_enabled",
};

// Every column this module reads — handy for callers building a `.select(...)`
// projection that needs all of them (e.g. the settings route's own read).
export const EMAIL_TOGGLE_COLUMNS: (keyof EmailToggleSettings)[] = Object.values(COLUMN_FOR_KIND);

/** Should this email kind actually send, given the app_settings row (or
 * whatever projection of it the caller fetched)? Missing settings row, a
 * missing column in the projection, or `null` (a settings row written before
 * this migration) all fail OPEN to "enabled" — a toggle a caller forgot to
 * select must never silently swallow email. Only an explicit `false` gates
 * the send off. */
export function emailEnabled(settings: EmailToggleSettings | null | undefined, kind: EmailToggleKind): boolean {
  if (!settings) return true;
  const value = settings[COLUMN_FOR_KIND[kind]];
  return value !== false;
}
