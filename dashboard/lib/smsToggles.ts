// Per-kind SMS on/off toggles (Settings → Notifications). Pure lookup, no I/O
// — each send site reads its own `app_settings` row and asks this whether the
// SMS leg should fire. The SMS sibling of lib/emailToggles.ts, with one
// deliberate difference: this one FAILS CLOSED.
//
// emailEnabled() fails OPEN because email predates its toggles — a column a
// caller forgot to select must never silently swallow email that was already
// sending. SMS is the opposite case: it ships dark behind columns that default
// FALSE, and an accidental send to a real florist's phone is the failure worth
// preventing. So only an explicit `true` sends.
//
// See supabase/migrations/2026-08-03-sms.sql.

export type SmsToggleKind = "offer" | "recruiting" | "accept_confirm";

// A structural subset of AppSettings — callers pass whatever `.select(...)`
// projection they already fetched.
export interface SmsToggleSettings {
  sms_offer_enabled?: boolean | null;
  sms_recruiting_enabled?: boolean | null;
  sms_accept_confirm_enabled?: boolean | null;
}

const COLUMN_FOR_KIND: Record<SmsToggleKind, keyof SmsToggleSettings> = {
  offer: "sms_offer_enabled",
  recruiting: "sms_recruiting_enabled",
  accept_confirm: "sms_accept_confirm_enabled",
};

/** Every column this module reads — for callers building a `.select(...)`. */
export const SMS_TOGGLE_COLUMNS: (keyof SmsToggleSettings)[] = Object.values(COLUMN_FOR_KIND);

/** Should this SMS kind actually send? FAILS CLOSED: a missing settings row, a
 * missing column in the projection, or `null` all mean "do not send". Only an
 * explicit `true` enables. */
export function smsEnabled(
  settings: SmsToggleSettings | null | undefined,
  kind: SmsToggleKind
): boolean {
  if (!settings) return false;
  return settings[COLUMN_FOR_KIND[kind]] === true;
}
