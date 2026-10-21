// Types mirror `supabase/schema.sql` column-for-column. Nullable columns in the
// schema are optional/nullable here too — never widen a nullable DB column to a
// non-null TS type, or the scoring/spread math loses its null guards.

export interface City {
  id: string;
  country: string;
  city: string;
  center_lat: number;
  center_lng: number;
  // Search radius (km) used for the most recent ingest of this city. Null
  // for cities ingested before radius-based scraping shipped — the UI shows
  // "—" rather than fabricating a value.
  radius_km: number | null;
  // Administrative region (state/province) captured from Nominatim's
  // geocoding response. Null when Nominatim didn't provide one, or for
  // cities ingested before region capture shipped — the UI groups those
  // under an "Other" region rather than fabricating a value.
  region: string | null;
  ingested_at: string;
}

// Pipeline lifecycle — mirrors florists.lifecycle_stage (text, check-constrained).
export type LifecycleStage =
  | "found"
  | "targeted"
  | "contacted"
  | "engaged"
  | "onboarding"
  | "production"
  | "lost";

export interface Florist {
  id: string;
  city_id: string;
  place_id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  review_count: number | null;
  distance_km_from_center: number | null;
  // Maps-native fields
  phone_maps: string | null;
  website_url: string | null;
  // Enrichment fields
  has_website: boolean;
  is_ecommerce: boolean | null; // null = unknown
  ecommerce_signals: Record<string, unknown> | null;
  email: string | null;
  phone_web: string | null;
  owner_name: string | null;
  shop_highlight: string | null;
  enrichment_notes: string | null;
  drafted_email: string | null;
  ingested_at: string;
  deleted_at: string | null;
  excluded_at: string | null;
  /** A florist WE own, used to exercise the real order loop. While
   *  app_settings.test_mode is on, a test shop receives REAL email/SMS at its
   *  own address with a WORKING magic link; everyone else gets the shared test
   *  inbox and inert placeholder tokens (lib/offerVars.ts). Also governs
   *  automatic matching via app_settings.test_shop_matching (lib/match.ts). */
  is_test_shop?: boolean | null;
  lifecycle_stage: LifecycleStage;
  source: "existing" | "known" | "new" | null;
  source_notes: string | null;
  exclusion_reason: string | null;
  delivery_radius_km: number | null;
  business_hours: Record<string, unknown> | null;
  capacity_per_day: number | null;
  payout_terms: string | null;
  whatsapp: string | null;
  preferred_channel: "email" | "whatsapp" | "app" | null;
  trust_tier: "1" | "2" | "3" | "4" | null;
  onboarded_at: string | null;
  airwallex_payout_ref: string | null;
  // Facundo-minted Florist ID (7-digit integer), assigned per-shop by staff
  // via POST /api/florists/assign-number (assign_florist_number() DB
  // function). NOT copied from Odoo — see lib/floristNumber.ts for the
  // reserved-range constant. Written back to Shopify under the "Tookan
  // Florist Id" metafield name (confirmed live 2026-08-21) for backward
  // compat; see lib/shopifyWriteback.ts for the our-name -> Shopify-name
  // mapping — see supabase/migrations/2026-08-21-florist-number.sql.
  florist_number: number | null;
  // BCP-47-ish locale tag for outbound email copy (see lib/i18n); null =
  // unknown, falls back to EN. Nullable/additive — supabase/migrations/2026-07-26-florists-locale.sql.
  locale: string | null;
  // Self-service order-email unsubscribe (dashboard/app/florist/unsubscribe) —
  // see supabase/migrations/2026-07-27-florist-email-unsubscribe.sql.
  order_emails_snoozed_until: string | null;
  order_emails_opt_out: boolean;
  unsubscribe_token: string | null;
  // Self-registration ("join our network") — see
  // supabase/migrations/2026-08-03-florist-join-network.sql.
  join_token: string | null;
  join_token_expires_at: string | null;
  joined_at: string | null;
  next_day_cutoff_hour: number | null;
  // Self-service order-SMS unsubscribe, the SMS sibling of order_emails_*
  // (independent — see supabase/migrations/2026-08-03-sms.sql).
  order_sms_opt_out: boolean | null;
  order_sms_snoozed_until: string | null;
  // Generated recruiting-outreach SMS draft — the SMS sibling of drafted_email.
  drafted_sms: string | null;
}

export interface Weights {
  rating: number; // default 1.0
  reviews: number; // default 0.8
  website: number; // default 0.5
  ecommerce: number; // default 1.0
  distance: number; // default 0.3 (penalty)
  minRating: number; // default 4.0
  minReviews: number; // default 20
}

// Spread-selection parameters — separate from Weights because selectSpread()
// takes them as explicit arguments rather than reading them off a Weights object.
export interface SelectionParams {
  topK: number; // default 5
  minSeparationMeters: number; // default 500
}

export interface ScoreBreakdownResult {
  rating: number;
  reviews: number;
  website: number;
  ecommerce: number;
  distance: number;
}

// Per-call-type LLM cost breakdown — a value of `ingest_jobs.llm_cost_by_type`
// (JSONB, keyed by call type: ecommerce/email/phone/owner/draft). See
// ingest/usage.py's UsageTracker.to_by_type_dict().
export interface LlmTypeCost {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  model: string;
}

// Mirrors `ingest_jobs` in supabase/schema.sql column-for-column. Written
// only by the ingest CLI (service-role, bypasses RLS); the dashboard only
// ever reads these rows via the RLS-scoped session client (app/api/jobs).
export interface IngestJob {
  id: string;
  country: string;
  city: string;
  radius_km: number | null;
  limit_per_keyword: number | null;
  keywords: string[] | null;
  language: string | null;
  /** 'city' = the full ingest. 'repair' = re-enrich florists already stored for
   *  this city, no Apify scrape (see ingest-worker/src/repair.ts). Nullable
   *  because rows written before the column existed carry no value; treat null
   *  as 'city'. */
  mode: "city" | "repair" | null;
  status: "queued" | "running" | "succeeded" | "failed";
  last_line: string | null;
  log: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  // Cost + timing (workstream A) — all nullable: null while running, and for
  // rows ingested before this shipped. Never fabricated — see lib/cost.ts.
  input_tokens: number | null;
  output_tokens: number | null;
  llm_calls: number | null;
  llm_cost_usd: number | null;
  llm_cost_by_type: Record<string, LlmTypeCost> | null;
  apify_cost_usd: number | null;
  florist_count: number | null;
}

// Mirrors `app_settings` in supabase/schema.sql — a singleton config row
// (id is always 1). Written only via POST /api/settings (service-role);
// read by allow-listed users via RLS.
export interface AppSettings {
  id: number;
  test_mode: boolean;
  /** How automatic matching treats florists.is_test_shop: 'exclude' (default —
   *  a paying customer's order can never reach a test shop) or 'only' (matching
   *  routes exclusively to test shops, a deliberate testing mode). */
  test_shop_matching?: "exclude" | "only" | null;
  test_email: string | null;
  test_phone: string | null;
  cx_email: string | null;
  // Florist-facing support contact shown in the offer-email footer; null =
  // fall back to the hardcoded default (lib/reachoutSend.ts). See
  // supabase/migrations/2026-07-27-florist-email-unsubscribe.sql.
  florist_support_email: string | null;
  payments_paused: boolean;
  hold_delivery_payouts: boolean;
  shopify_writeback_enabled: boolean;
  // Percent of the order total (incl. shipping) offered to the florist —
  // admin-editable in Settings → Payments. See lib/payout.ts.
  default_payout_percent: number;
  workflow_mode: "manual" | "semi" | "auto";
  // Tag allow-list criterion for the working set. Kept as the same DB column
  // introduced in 2026-07-26, but the match/work gate now goes through
  // isInWorkingSet below: empty tags alone do NOT mean "work every order".
  active_order_tags: string[];
  // Working-set criteria (see lib/orderTags.ts::isInWorkingSet and
  // supabase/migrations/2026-09-10-working-set-settings.sql). An order is
  // matched/worked only if run_all_orders is true, OR its tags intersect
  // active_order_tags, OR its delivery country is in active_order_countries.
  // All empty/false = NO order is worked (the safe default).
  active_order_countries: string[];
  run_all_orders: boolean;
  // Search radius (km) from an order's delivery coordinates used to decide
  // whether the local florist pool has a usable candidate on working-set
  // entry, before requesting ingest instead of silently escalating. Default 5.
  working_set_radius_km: number;
  // CX alert-sweep throttle state (dashboard/lib/cxAlerts.ts) — null until the
  // first alert fires. Never written from the client; the sweep owns these.
  cx_alert_last_sent_at: string | null;
  cx_alert_last_hash: string | null;
  // Per-email-type on/off toggles — all default true (enabled). See
  // supabase/migrations/2026-07-26-email-toggles.sql for full off-semantics
  // and lib/emailToggles.ts::emailEnabled for the read helper each send site
  // uses. Each toggle gates the EMAIL only — never the non-email side (push,
  // atomic claims, status updates) of the same send site.
  email_offer_enabled: boolean;
  email_accept_confirm_enabled: boolean;
  email_client_assigned_enabled: boolean;
  email_client_on_the_way_enabled: boolean;
  email_client_delivered_enabled: boolean;
  email_issue_to_florist_enabled: boolean;
  email_issue_to_cx_enabled: boolean;
  email_cx_alert_enabled: boolean;
  email_recruiting_enabled: boolean;
  /** Maximum number of live sent/opened offers the wave engine may keep open per order.
   *  1 = sequential one-at-a-time funnel; >1 fans out to multiple ranked candidates. */
  offer_parallel_sends: number | null;
  // How long a florist gets to respond to an offer, per delivery-urgency tier
  // (minutes). Read at send time by lib/offerVars.ts and fed to
  // lib/reachout.ts::suggestedTimeoutMinutes, whose DEFAULT_OFFER_WINDOWS are
  // these columns' defaults. See supabase/migrations/2026-08-03-late-accept-and-offer-window.sql.
  offer_window_rush_min: number;      // delivery <= 6h
  offer_window_sameday_min: number;   // <= 24h
  offer_window_standard_min: number;  // <= 72h
  offer_window_far_min: number;       // beyond 72h
  offer_window_nodate_min: number;    // order has no delivery_at
  // How long to leave a shop alone after an unanswered call, same tiers.
  call_back_gap_rush_min: number;
  call_back_gap_sameday_min: number;
  call_back_gap_standard_min: number;
  call_back_gap_far_min: number;
  call_back_gap_nodate_min: number;
  // How close to delivery a lapsed offer stops being acceptable (hours). See
  // lib/lateAccept.ts::acceptBlockReason.
  late_accept_buffer_hours: number;
  /** Margin before delivery reserved for a human — the wave engine stands down
   *  rather than starting an offer whose window would end inside it. */
  cx_reserve_hours: number;
  /** Short sidebar for non-admin staff — see OPERATOR_HIDDEN in
   *  components/shell/StaffShell.tsx. Hides links, grants nothing. */
  operator_view: boolean;
  /** false = every offer email uses the full opening (lib/offerVars.ts). */
  offer_short_variant_enabled: boolean;
  // SMS toggles — the SMS sibling of the email_*_enabled toggles above, but
  // default FALSE (ships dark; see supabase/migrations/2026-08-03-sms.sql and
  // lib/smsToggles.ts, which fails CLOSED to match).
  sms_offer_enabled: boolean | null;
  sms_recruiting_enabled: boolean | null;
  sms_accept_confirm_enabled: boolean | null;
  // OpenRouter model slug used by the Statistics page's LLM chat
  // (app/api/stats/chat/route.ts). Editable from Settings → Statistics chat;
  // validated server-side against STATS_CHAT_MODELS in app/api/settings/route.ts.
  // See supabase/migrations/2026-08-05-stats-chat-settings.sql.
  stats_chat_model: string;
  // Per-message-kind email voice: kind -> "branded" | "plain". See
  // lib/messageVoice.ts::voiceForKind (fails open to "branded") and
  // supabase/migrations/2026-08-08-message-voice.sql for why this is one jsonb
  // column rather than a boolean per kind.
  message_voice: Record<string, string> | null;
  // MATCHING (Settings → Matching). Every knob in lib/match.ts::MatchConfig;
  // read by both the worker's automatic match and the backoffice re-match via
  // parseMatchConfig, which falls back per-field so a null column behaves as the
  // compiled default. See supabase/migrations/2026-08-06-matching-config.sql.
  //
  // Ascending km boundaries; candidates sort by ring BEFORE score, and the last
  // edge is the hard cap — nothing beyond it is ever offered.
  match_ring_edges_km: number[] | null;
  match_weight_distance: number | null;
  match_weight_onboarded: number | null;
  match_weight_emailable: number | null;
  match_weight_quality: number | null;
  match_weight_source: number | null;
  match_weight_tier: number | null;
  match_weight_performance: number | null;
  match_top_n: number | null;
  /** Hard ceiling on offer waves per order; match_max_waves x match_top_n is the
   *  most shops an order is offered to unattended. */
  match_max_waves: number | null;
  /** Quality floors — null means "no floor", not "floor of zero". */
  match_min_rating: number | null;
  match_min_review_count: number | null;
  match_allow_unrated: boolean | null;
  match_exclude_tier4: boolean | null;
  /** A florist with no trust tier has no payout split, so this defaults true. */
  match_require_trust_tier: boolean | null;
  // OUTREACH — the multi-touch recruiting program. All three booleans fail
  // CLOSED: a null reads as false everywhere, so a row that predates the
  // migration cannot start a funnel, offer a real order to an unvetted shop, or
  // let a model answer a stranger. See components/settings/OutreachPanel.tsx.
  /** Master switch. Off, enrolments are recorded but lib/sequences/tick.ts sends nothing. */
  sequence_enabled: boolean | null;
  /** Opt-in: the tick enrols freshly scraped `found` shops into recruit_cold.
   *  Null reads as false; no effect unless sequence_enabled is also on. */
  sequence_auto_enrol_scraped: boolean | null;
  sequence_min_gap_hours: number | null;
  /** Blast radius, not a target — sends stop for the day once hit. */
  sequence_daily_send_cap: number | null;
  cold_offer_enabled: boolean | null;
  cold_offer_max_payout_eur: number | null;
  /** Above this, an unvetted shop's 70% parks for CX instead of issuing. */
  cold_offer_auto_payout_cap_eur: number | null;
  cold_offer_default_radius_km: number | null;
  cx_agent_enabled: boolean | null;
  /** The order-chat agent (lib/agentTurn.ts kind="support"). Separate switch
   * from cx_agent_enabled: different audience, different taxonomy. */
  support_agent_enabled?: boolean | null;
  /** Whether the OrderChat widget renders at all on a florist's order page.
   * Separate from support_agent_enabled: that one only gates the AI's
   * auto-reply once the chat is open. */
  florist_chat_enabled?: boolean | null;
  cx_agent_min_confidence: number | null;
  cx_agent_max_auto_turns: number | null;
  updated_at: string;
}

// Mirrors `outreach` in supabase/schema.sql column-for-column — one row per
// send attempt (sent or failed). Written only via POST /api/outreach/send
// (service-role); read by allow-listed users via RLS.
export interface Outreach {
  id: string;
  florist_id: string;
  channel: "email" | "sms";
  status: "sent" | "failed";
  intended_address: string | null;
  to_address: string | null;
  test_mode: boolean;
  subject: string | null;
  body: string | null;
  provider_message_id: string | null;
  error: string | null;
  sent_by: string | null;
  sent_at: string;
}

// Mirrors `florist_notes` in supabase/schema.sql — free-text notes on a
// florist. Written only via POST /api/florists/note (service-role); read by
// allow-listed users via RLS.
export interface FloristNote {
  id: string;
  florist_id: string;
  author: string | null;
  body: string;
  created_at: string;
}

// Mirrors `florist_meetings` — logged/scheduled meetings + follow-ups. Written
// only via POST /api/florists/meeting (service-role); read via RLS.
export interface FloristMeeting {
  id: string;
  florist_id: string;
  title: string | null;
  meeting_at: string;
  outcome: string | null;
  next_follow_up_at: string | null;
  created_by: string | null;
  created_at: string;
}

// ---- Phase 0 order model (supabase/migrations/2026-07-13-phase0-orders.sql) ----
import type { OrderStatus, AssignmentStatus } from "./orderStatus";

export interface TrustTier {
  code: "1" | "2" | "3" | "4";
  label: string;
  split_on_accept: number;
  split_on_delivery: number;
  photo_required: boolean;
  hold_payout: boolean;
  exposure_cap_eur: number | null;
  updated_at: string;
}

/** The florist columns the discovery / pipeline screens actually read — the
 * per-city grouping, the phase counts, the engagement lists, and the
 * Supply-health aggregates.
 *
 * `/discovery` selects exactly these rather than `*`: at 6,264 rows a full
 * select was ~1.8 KB each (~11.4 MB) for ten fields' worth of rendering. A full
 * `Florist` satisfies this structurally, so callers holding whole rows still
 * pass. Keep it in step with the select in app/(staff)/discovery/page.tsx. */
export type PipelineFlorist = Pick<
  Florist,
  | "id"
  | "name"
  | "city_id"
  | "email"
  | "rating"
  | "review_count"
  | "lifecycle_stage"
  | "phone_maps"
  | "phone_web"
  | "is_ecommerce"
  | "drafted_email"
>;

export interface Order {
  id: string;
  shopify_order_id: string | null;
  order_name: string | null;
  shopify_created_at: string | null;
  currency: string | null;
  total: number | null;
  shipping_total: number | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  locale: string | null;
  city_id: string | null;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  delivery_address: Record<string, unknown> | null;
  delivery_area: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_at: string | null;
  delivery_window: string | null;
  occasion: string | null;
  greeting: string | null;
  tags: string | null;
  substitution_policy: string | null;
  status: OrderStatus;
  notes: string | null;
  raw: Record<string, unknown> | null;
  created_at: string;
  deleted_at: string | null;
  /** Non-null = staff explicitly picked this order into the WORKING SET — the
   *  set the system actually operates on, union'd with
   *  app_settings.active_order_tags. See lib/workingSet.ts::isInWorkingSet and
   *  supabase/migrations/2026-08-11-order-working-set.sql. Cleared automatically
   *  by the reconcile sweep once the order reaches a terminal state. */
  worklist_at: string | null;
  /** Email of whoever added it. Audit only — the authoritative trail is the
   *  worklist_added / worklist_removed rows in order_events. */
  worklist_by: string | null;
}

export interface OrderLineItem {
  id: string;
  order_id: string;
  title: string | null;
  variant: string | null;
  sku: string | null;
  catalog_id: string | null;
  /** Shopify variant id. Null on every row imported before 2026-08-06 — the
   *  recipe's translation lookup falls back to a model draft for those. */
  variant_id: string | null;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  product_type: string | null;
  bouquet_spec: string | null;
  image_url: string | null;
  personalization: string | null;
  barcode: string | null;
  components: string | null;
  addons: string | null;
  variant_text: string | null;
  variant_icon_url: string | null;
}

export interface OrderAssignment {
  id: string;
  order_id: string;
  florist_id: string;
  rank: number | null;
  florist_source: string | null;
  status: AssignmentStatus;
  offer_kind: "exclusive" | "race" | null;
  offer_expires_at: string | null;
  sla_deadline_at: string | null;
  decline_reason: string | null;
  decline_detail: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  payout_price: number | null;
  // Percent of the order total that payout_price represents, snapshotted from
  // app_settings.default_payout_percent at match time — see lib/payout.ts.
  payout_percent: number | null;
  assigned_at: string;
  sent_at: string | null;
  opened_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  declined_at: string | null;
  // Staff took this offer off the table (Reach-out → Withdraw). Set instead of
  // a new status value, and checked by lib/lateAccept.ts::acceptBlockReason —
  // without it a lapsed offer would stay acceptable, since `expired` no longer
  // means "closed". See supabase/migrations/2026-08-03-late-accept-and-offer-window.sql.
  withdrawn_at: string | null;
}

export interface DeliveryEvent {
  id: string;
  assignment_id: string;
  type: string;
  photo_key: string | null;
  note: string | null;
  created_at: string;
}

export interface Payout {
  id: string;
  assignment_id: string | null;
  florist_id?: string | null; // set only for leg='manual' — see the 2026-07-30 migration
  leg: "accept" | "delivery" | "manual";
  amount: number | null;
  currency: string | null;
  rail: "card" | "sepa" | null;
  status: "pending" | "issued" | "paid" | "failed" | "clawed_back" | "held";
  provider_ref: string | null;
  created_at: string;
  updated_at: string;
  // Airwallex v2 lifecycle (fed by webhooks; nullable until an event lands).
  card_status?: string | null;
  expires_at?: string | null;
  spent_amount?: number | null;
  settled_at?: string | null;
  dispute_status?: string | null;
  last_txn_id?: string | null;
}

// One provider's judgment inside `PhotoVerification.providers` — mirrors
// lib/photoVerify/types.ts::ProviderResult as persisted to the DB (jsonb).
export interface PhotoVerificationProvider {
  provider: string;
  ok: boolean;
  matched: boolean;
  confidence: number;
  itemsFound: string[];
  itemsMissing: string[];
  notes: string;
  model?: string;
  error?: string;
}

// A row from `photo_verifications` — the AI photo-verify check's recorded
// judgment for one delivered-photo upload. Informational only: it does not
// (currently) gate the payout — see dashboard/lib/photoVerify/ and the
// `payout_hold` handling in lib/payoutHold.ts for the actual gate logic,
// which this type deliberately has nothing to do with.
export interface PhotoVerification {
  id: string;
  order_id: string;
  assignment_id: string;
  photo_key: string;
  verdict: "pass" | "review" | "fail";
  confidence: number | null;
  providers: PhotoVerificationProvider[];
  items_expected: unknown;
  reasoning: string | null;
  created_at: string;
  // Shadow-mode-only OpenRouter legs — logged for evaluation, never drove the
  // verdict above. All nullable/absent when that leg didn't run.
  openrouter_gemini_score?: number | null;
  openrouter_gemini_matched?: boolean | null;
  openrouter_gemini_confidence?: number | null;
  openrouter_gemini_notes?: string | null;
  openrouter_gemini_model?: string | null;
  openrouter_gemini_ok?: boolean | null;
  openrouter_gemini_error?: string | null;
  openrouter_qwen_score?: number | null;
  openrouter_qwen_matched?: boolean | null;
  openrouter_qwen_confidence?: number | null;
  openrouter_qwen_notes?: string | null;
  openrouter_qwen_model?: string | null;
  openrouter_qwen_ok?: boolean | null;
  openrouter_qwen_error?: string | null;
}

export interface OrderEvent {
  id: string;
  order_id: string;
  type: string;
  payload: Record<string, unknown> | null;
  actor: string | null;
  created_at: string;
}

export type OrderIssueType =
  | "missing_ingredient" | "wrong_address" | "out_of_range"
  | "recipient_unavailable" | "damaged_wrong_recipient" | "other";

// Lightweight florist row for the order page's "add any florist" picker.
export interface FloristDirectoryEntry {
  id: string;
  name: string;
  lifecycle_stage: string | null;
  trust_tier: string | null;
  address: string | null;
  city_id: string | null;
  excluded_at: string | null;
}

// A step-mode (semi) pending action the system proposed, awaiting a human to
// approve / edit / reject before it fires. Generalized from offer-only to every
// system-initiated transition — see docs .../2026-07-26-semi-auto-approvals-design.md.
export type OrderApprovalKind =
  | "match" | "offer" | "reassign" | "escalate" | "writeback"
  | "client_assigned" | "client_on_the_way" | "client_delivered" | "chase_photo";

// Structured preview payloads by kind (what the cockpit / order-page panel render).
export interface ApprovalEmailPreview { to: string | null; subject: string; html: string; testMode: boolean }
export interface ApprovalMatchPreview { candidates: Array<{ floristId: string; floristName: string | null; rank: number | null; distanceKm: number | null }> }
export interface ApprovalWritebackPreview {
  shopifyOrderId: string;
  state: string;
  florist?: string | null;
  // Our Florist ID (florists.florist_number), if this florist has one set —
  // CX will see it written to the "Tookan Florist Id" Shopify metafield
  // (name differs on that side; see lib/shopifyWriteback.ts).
  floristNumber?: number | null;
  // Tookan Cost Of Order metafield value CX will see written (delivery only — both payout
  // legs must exist). Carries the currency so the preview can render it unambiguously.
  totalPayout?: { amount: number; currency: string } | null;
}
export interface ApprovalReasonPreview { reason: string; detail?: string | null }
export type ApprovalPreview =
  | ({ type: "email" } & ApprovalEmailPreview)
  | ({ type: "match" } & ApprovalMatchPreview)
  | ({ type: "writeback" } & ApprovalWritebackPreview)
  | ({ type: "reason" } & ApprovalReasonPreview);

export interface OrderApproval {
  id: string;
  order_id: string;
  assignment_id: string | null;
  kind: OrderApprovalKind;
  status: "pending" | "approved" | "rejected" | "skipped";
  draft_subject: string | null;
  draft_body: string | null;
  preview: ApprovalPreview | null;
  payload: Record<string, unknown> | null;
  dedupe_key: string | null;
  created_by: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
}

export interface OrderIssue {
  id: string;
  order_id: string;
  assignment_id: string | null;
  type: OrderIssueType;
  detail: string | null;
  stage: string | null;
  status: "open" | "resolved";
  resolution: string | null;
  resolution_action: string | null;
  created_by: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
  florist_unread: boolean;
  cx_unread: boolean;
}

export interface IssueMessage {
  id: string;
  issue_id: string;
  order_id: string;
  assignment_id: string | null;
  author_role: "florist" | "cx" | "system";
  author: string | null;
  body: string;
  created_at: string;
}
