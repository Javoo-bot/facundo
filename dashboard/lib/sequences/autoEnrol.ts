// Which freshly scraped shops enter the recruiting funnel on their own.
//
// Pure and alias-free so the rule is one screen you can read and assert on.
// The I/O around it (the query + the enrol() calls) is
// reconcile.ts::enrolNewlyScrapedShops; the switch it sits behind is
// app_settings.sequence_auto_enrol_scraped (migration 2026-08-19).
//
// The load-bearing idea: this does NOT invent a new way into the funnel. It
// decides WHO, then hands each shop to the same enrol() staff use from
// /discovery, which already dedupes per inbox and per florist. Everything the
// funnel enforces downstream (sequence_enabled, daily send cap, opt-out,
// test mode routing) applies to an auto-enrolled shop exactly as to a
// hand-enrolled one.

/** How far back "freshly scraped" reaches. Turning the switch on must not
 * sweep the whole historical backlog (5,800+ `found` rows on prod) into the
 * funnel — that is a deliberate staff campaign, not a side effect of a toggle.
 * Two weeks comfortably covers an ingest queued by an uncovered order and the
 * staff decision to enable this afterwards. */
export const AUTO_ENROL_LOOKBACK_DAYS = 14;

/** Enrolments per tick. The tick runs every minute, so this is a rate, not a
 * total: 25/min drains a 150-shop city in six minutes without ever letting a
 * bug (or a mass ingest) create thousands of enrolments inside one tick. The
 * daily send cap bounds the EMAILS either way; this bounds the ROWS, so the
 * first day's numbers stay readable. */
export const AUTO_ENROL_PER_TICK = 25;

export interface AutoEnrolSettings {
  sequence_enabled?: boolean | null;
  sequence_auto_enrol_scraped?: boolean | null;
  /** Country allow-list for the sweep, as the codes `cities.country` stores
   * (ISO-2 on live data: 'ES', 'FR', …). **Null or empty means every country**,
   * which is exactly the behaviour before this column existed — the switch
   * cannot become more restrictive by accident on an un-migrated row.
   *
   * It exists because `sequence_auto_enrol_scraped` is otherwise GLOBAL, and a
   * country-scoped campaign run through a global switch spends its send cap on
   * whichever country was scraped most recently. Measured on prod the day this
   * shipped: flipping the switch for a Spain push would have enrolled 720
   * shops, of which 16 were Spanish — Denmark, France and Israel took 56% of
   * it. The daily cap is the scarce resource, so "also mail France" is not a
   * harmless superset; it is Spain getting 2% of the campaign. */
  sequence_auto_enrol_countries?: string[] | null;
}

/** Compare countries the way this rule means it: case- and space-insensitive.
 * `cities.country` is written by the ingest pipeline's `normalize_country`, so
 * live values are ISO-2, but an allow-list typed by a human in /settings should
 * not fail because someone wrote " es ". */
function countryMatches(country: string | null | undefined, allowed: readonly string[]): boolean {
  const c = (country ?? "").trim().toLowerCase();
  if (!c) return false; // unknown country cannot satisfy an explicit allow-list
  return allowed.some((a) => a.trim().toLowerCase() === c);
}

export interface AutoEnrolCandidate {
  /** From the shop's city (`cities.country`) — florists carry no country of
   * their own. Null when the join found nothing, which an explicit allow-list
   * treats as "not in it" rather than as a pass. */
  country?: string | null;
  lifecycle_stage?: string | null;
  email?: string | null;
  ingested_at?: string | null;
  joined_at?: string | null;
  excluded_at?: string | null;
  deleted_at?: string | null;
  order_emails_opt_out?: boolean | null;
  is_test_shop?: boolean | null;
  /** Stamped by the Resend webhook when this address hard-bounced. A bounce
   * stops the LIVE run; this keeps a dead address from being enrolled again
   * later (e.g. an order offer bounced months before any recruiting). */
  email_bounced_at?: string | null;
  /** Set when the scraped address belongs to a network / franchise /
   * directory whose site hosts the shop's page — head office, not the shop.
   * Mailing "would you take orders in Lille?" to a chain's HQ, signed as if to
   * one branch, is the `reachout-wrong-recipient` branch on /lifecycle. Staff
   * can still choose to send by hand; automation does not. */
  network_id?: string | null;
  /** How many florist rows hold this exact address (maintained by the
   * network/repair sweeps). >1 means it is probably not THIS shop's inbox. */
  email_shared_count?: number | null;
  /** True when this florist — OR ANY OTHER LISTING SHARING ITS INBOX — has
   * EVER had a sequence_enrolments row, live or finished. A shop that
   * completed (or was stopped out of) a funnel is not "new" just because its
   * stage never moved; and a second listing of the same inbox is not a new
   * prospect after the first one's run has ended. Re-enrolling would restart
   * the same mail from the top. */
  everEnrolled?: boolean | null;
}

export type AutoEnrolBlockReason =
  | "disabled"          // the opt-in switch is off (or the master switch is)
  | "country-excluded"  // outside sequence_auto_enrol_countries
  | "not-found-stage"   // already targeted/contacted/… — a human or a send got here first
  | "no-email"
  | "too-old"           // ingested before the lookback window
  | "joined"
  | "excluded"
  | "opted-out"
  | "test-shop"
  | "bounced"           // address is known dead
  | "network-address"   // head-office / directory inbox, not the shop's
  | "shared-address"    // same address on several listings — probably not theirs
  | "already-enrolled";

/** Why this shop may NOT be auto-enrolled, or null when it may.
 *
 * Reason rather than boolean so the tick can say what it skipped — an empty
 * "autoEnrolled: 0" with no why is the silence that costs a day. Fails closed:
 * unreadable settings → "disabled". */
export function autoEnrolBlockReason(
  f: AutoEnrolCandidate,
  settings: AutoEnrolSettings | null | undefined,
  nowMs: number
): AutoEnrolBlockReason | null {
  if (!settings?.sequence_enabled || !settings?.sequence_auto_enrol_scraped) return "disabled";
  // Campaign scope before shop properties: "we are not mailing this country"
  // is a cleaner thing to read in the skip counts than a shop that was refused
  // for some incidental reason. Null/empty = every country (see the field doc).
  const allowed = settings.sequence_auto_enrol_countries;
  if (allowed && allowed.length > 0 && !countryMatches(f.country, allowed)) return "country-excluded";
  if (f.is_test_shop) return "test-shop";
  if (f.excluded_at || f.deleted_at) return "excluded";
  if (f.joined_at) return "joined";
  // Only the untouched. `targeted` means staff already picked them for a
  // campaign; `contacted`+ means something already went out.
  if ((f.lifecycle_stage ?? "found") !== "found") return "not-found-stage";
  if (!f.email || !f.email.trim()) return "no-email";
  if (f.order_emails_opt_out) return "opted-out";
  if (f.email_bounced_at) return "bounced";
  if (f.network_id) return "network-address";
  if ((f.email_shared_count ?? 1) > 1) return "shared-address";
  if (f.everEnrolled) return "already-enrolled";
  const ingested = f.ingested_at ? Date.parse(f.ingested_at) : NaN;
  if (!Number.isFinite(ingested) || nowMs - ingested > AUTO_ENROL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) {
    return "too-old";
  }
  return null;
}

export function autoEnrolEligible(
  f: AutoEnrolCandidate,
  settings: AutoEnrolSettings | null | undefined,
  nowMs: number
): boolean {
  return autoEnrolBlockReason(f, settings, nowMs) === null;
}

/** ISO timestamp of the start of the lookback window — what the sweep's
 * `ingested_at >= …` filter uses, so the query and the pure rule agree. */
export function autoEnrolSince(nowMs: number): string {
  return new Date(nowMs - AUTO_ENROL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
