import { requireRole } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isEmailVoice } from "@/lib/messageVoice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WORKFLOW_MODES = ["manual", "semi", "auto"];
// Short vetted list for the Statistics page's LLM chat (app/api/stats/chat/route.ts).
// Validated server-side — never trust the client to only ever send one of these.
// Checked against OpenRouter's live catalog (curl https://openrouter.ai/api/v1/models)
// at implementation time; kept in sync with the STATS_CHAT_MODELS list the frontend
// dropdown (SettingsClient.tsx) renders from.
const STATS_CHAT_MODELS = ["anthropic/claude-sonnet-5", "google/gemini-2.5-pro", "openai/gpt-5"];

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request): Promise<Response> {
  // AUTH GATE — admin role only (Settings manages the allow-list + safety switches).
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const {
    test_mode, test_email, test_phone, workflow_mode, cx_email, florist_support_email, payments_paused, hold_delivery_payouts,
    shopify_writeback_enabled, default_payout_percent, active_order_tags,
    active_order_countries, run_all_orders, working_set_radius_km,
    email_offer_enabled, email_accept_confirm_enabled, email_client_assigned_enabled, email_client_on_the_way_enabled, email_client_delivered_enabled,
    email_issue_to_florist_enabled, email_issue_to_cx_enabled, email_cx_alert_enabled, email_recruiting_enabled,
    offer_parallel_sends, offer_window_rush_min, offer_window_sameday_min, offer_window_standard_min, offer_window_far_min,
    offer_window_nodate_min, late_accept_buffer_hours, cx_reserve_hours, match_max_waves,
    call_back_gap_rush_min, call_back_gap_sameday_min, call_back_gap_standard_min, call_back_gap_far_min, call_back_gap_nodate_min,
    sms_offer_enabled, sms_recruiting_enabled, sms_accept_confirm_enabled,
    stats_chat_model, test_shop_matching, message_voice,
    match_ring_edges_km, match_weight_distance, match_weight_onboarded, match_weight_emailable,
    match_weight_quality, match_weight_source, match_weight_tier, match_weight_performance,
    match_top_n, match_min_rating, match_min_review_count, match_allow_unrated,
    match_exclude_tier4, match_require_trust_tier,
    operator_view,
    sequence_enabled, sequence_auto_enrol_scraped, sequence_min_gap_hours, sequence_daily_send_cap,
    cold_offer_enabled, cold_offer_max_payout_eur, cold_offer_auto_payout_cap_eur, cold_offer_default_radius_km,
    cx_agent_enabled, cx_agent_min_confidence, cx_agent_max_auto_turns,
    support_agent_enabled, florist_chat_enabled,
  } = (body ?? {}) as Record<string, unknown>;

  if (typeof test_mode !== "boolean") return jsonError("test_mode must be a boolean.", 400);
  const email = test_email == null || test_email === "" ? null : String(test_email).trim();
  const phone = test_phone == null || test_phone === "" ? null : String(test_phone).trim();
  const cx = cx_email == null || cx_email === "" ? null : String(cx_email).trim();
  // Can't be in test mode with no valid redirect target.
  if (test_mode && (!email || !EMAIL_RE.test(email))) {
    return jsonError("A valid test email is required when test mode is on.", 400);
  }
  if (cx && !EMAIL_RE.test(cx)) return jsonError("CX email must be a valid address.", 400);
  const floristSupport = florist_support_email == null || florist_support_email === "" ? null : String(florist_support_email).trim();
  if (floristSupport && !EMAIL_RE.test(floristSupport)) return jsonError("Florist support email must be a valid address.", 400);
  const mode = workflow_mode == null ? "manual" : String(workflow_mode);
  if (!WORKFLOW_MODES.includes(mode)) {
    return jsonError("workflow_mode must be manual, semi, or auto.", 400);
  }
  // Statistics-chat model (Settings → Statistics chat). Falls back to the
  // migration default rather than the previously-saved value — same
  // full-form-overwrite convention every other field on this route follows.
  const statsChatModel = stats_chat_model == null ? "anthropic/claude-sonnet-5" : String(stats_chat_model);
  if (!STATS_CHAT_MODELS.includes(statsChatModel)) {
    return jsonError(`stats_chat_model must be one of: ${STATS_CHAT_MODELS.join(", ")}.`, 400);
  }
  // How automatic matching treats test shops (florists WE own — see
  // supabase/migrations/2026-08-05-test-shops.sql). Anything unrecognized
  // resolves to 'exclude': the mode that keeps paying customers' orders off a
  // shop we only use for testing, so a bad value can never open that door.
  const testShopMatching = test_shop_matching === "only" ? "only" : "exclude";

  const payoutPercent = default_payout_percent == null ? 55 : Number(default_payout_percent);
  if (!Number.isFinite(payoutPercent) || payoutPercent < 0 || payoutPercent > 100) {
    return jsonError("default_payout_percent must be a number between 0 and 100.", 400);
  }
  // Active order tags: an opt-in allow-list gating matching (see
  // lib/orderTags.ts::hasActiveTag). Accept an array of strings, trim each,
  // drop empties, and dedupe — never fabricate a tag, an omitted/null field
  // just means "no filtering" ([]).
  if (active_order_tags != null && !Array.isArray(active_order_tags)) {
    return jsonError("active_order_tags must be an array of strings.", 400);
  }
  const activeOrderTags = active_order_tags == null
    ? []
    : [...new Set(
        (active_order_tags as unknown[])
          .map((t) => (typeof t === "string" ? t.trim() : ""))
          .filter((t) => t.length > 0)
      )];

  // Working-set countries: same accept-array-of-strings shape as
  // active_order_tags, but upper-cased (Shopify shipping country codes, e.g.
  // "ES") since that's how orders are matched against it — see
  // lib/orderTags.ts::isInWorkingSet.
  if (active_order_countries != null && !Array.isArray(active_order_countries)) {
    return jsonError("active_order_countries must be an array of strings.", 400);
  }
  const activeOrderCountries = active_order_countries == null
    ? []
    : [...new Set(
        (active_order_countries as unknown[])
          .map((c) => (typeof c === "string" ? c.trim().toUpperCase() : ""))
          .filter((c) => c.length > 0)
      )];

  const runAllOrders = run_all_orders === true;

  const radiusKm = working_set_radius_km == null ? 5 : Number(working_set_radius_km);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 100) {
    return jsonError("working_set_radius_km must be a number between 0 and 100 (km).", 400);
  }

  // Per-email-type toggles (Settings → Notifications) — boolean coercion,
  // default true (enabled) so an omitted/malformed field never silently
  // disables a send. See supabase/migrations/2026-07-26-email-toggles.sql.
  const boolOrDefault = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
  const emailToggles = {
    email_offer_enabled: boolOrDefault(email_offer_enabled, true),
    email_accept_confirm_enabled: boolOrDefault(email_accept_confirm_enabled, true),
    email_client_assigned_enabled: boolOrDefault(email_client_assigned_enabled, true),
    email_client_on_the_way_enabled: boolOrDefault(email_client_on_the_way_enabled, true),
    email_client_delivered_enabled: boolOrDefault(email_client_delivered_enabled, true),
    email_issue_to_florist_enabled: boolOrDefault(email_issue_to_florist_enabled, true),
    email_issue_to_cx_enabled: boolOrDefault(email_issue_to_cx_enabled, true),
    email_cx_alert_enabled: boolOrDefault(email_cx_alert_enabled, true),
    email_recruiting_enabled: boolOrDefault(email_recruiting_enabled, true),
  };

  const parallelSends = offer_parallel_sends == null ? 1 : Number(offer_parallel_sends);
  if (!Number.isInteger(parallelSends) || parallelSends < 1 || parallelSends > 10) {
    return jsonError("Parallel live offers must be a whole number between 1 and 10.", 400);
  }

  // Offer window per urgency tier + the late-accept buffer. Whole numbers only
  // — a fractional window would render a nonsense countdown — and each falls
  // back to today's hardcoded value when the field is omitted, so an older
  // client that doesn't send them can still save the rest of the form without
  // silently zeroing a window. Ranges are sanity rails, not policy: 1..1440
  // minutes (a window under a minute can't be answered; over a day the wave
  // engine is the wrong tool) and 0..72h of buffer (0 = accept right up to the
  // delivery moment).
  const ints: Record<string, number> = {};
  for (const [key, raw, dflt, lo, hi, label] of [
    ["offer_window_rush_min", offer_window_rush_min, 15, 1, 1440, "Rush offer window"],
    ["offer_window_sameday_min", offer_window_sameday_min, 30, 1, 1440, "Same-day offer window"],
    ["offer_window_standard_min", offer_window_standard_min, 60, 1, 1440, "Standard offer window"],
    ["offer_window_far_min", offer_window_far_min, 120, 1, 1440, "Far-out offer window"],
    ["offer_window_nodate_min", offer_window_nodate_min, 60, 1, 1440, "No-delivery-date offer window"],
    ["call_back_gap_rush_min", call_back_gap_rush_min, 10, 1, 1440, "Call-back gap (rush)"],
    ["call_back_gap_sameday_min", call_back_gap_sameday_min, 20, 1, 1440, "Call-back gap (sameday)"],
    ["call_back_gap_standard_min", call_back_gap_standard_min, 45, 1, 1440, "Call-back gap (standard)"],
    ["call_back_gap_far_min", call_back_gap_far_min, 120, 1, 1440, "Call-back gap (far)"],
    ["call_back_gap_nodate_min", call_back_gap_nodate_min, 45, 1, 1440, "Call-back gap (nodate)"],
    ["late_accept_buffer_hours", late_accept_buffer_hours, 2, 0, 72, "Late-accept buffer"],
    // The margin the wave engine leaves a human when it stands down early
    // (lib/waveGuards.ts). 0 = keep offering right up to the delivery moment,
    // which is legal but means CX inherits an order it cannot place.
    ["cx_reserve_hours", cx_reserve_hours, 2, 0, 72, "CX reserve"],
  ] as [string, unknown, number, number, number, string][]) {
    const n = raw == null ? dflt : Number(raw);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      return jsonError(`${label} must be a whole number between ${lo} and ${hi}.`, 400);
    }
    ints[key] = n;
  }
  // Per-SMS-kind toggles (Settings → Notifications) — the sibling of
  // emailToggles above, with the opposite default: false (disabled) so an
  // omitted/malformed field never silently turns SMS on. See
  // lib/smsToggles.ts (fails closed) and supabase/migrations/2026-08-03-sms.sql.
  const smsToggles = {
    sms_offer_enabled: boolOrDefault(sms_offer_enabled, false),
    sms_recruiting_enabled: boolOrDefault(sms_recruiting_enabled, false),
    sms_accept_confirm_enabled: boolOrDefault(sms_accept_confirm_enabled, false),
  };

  // Per-message-kind email voice (Settings → Notifications). Validated
  // key-by-key and UNKNOWN VALUES ARE DROPPED, not rejected: this is a
  // full-form overwrite, so a client one deploy behind would otherwise have to
  // choose between failing the whole save and writing back a value no send site
  // understands. Dropping degrades that kind to "branded", which is what
  // lib/messageVoice.ts resolves it to anyway.
  const messageVoice: Record<string, string> = {};
  if (message_voice && typeof message_voice === "object" && !Array.isArray(message_voice)) {
    for (const [kind, value] of Object.entries(message_voice as Record<string, unknown>)) {
      if (typeof kind === "string" && kind.length > 0 && kind.length <= 64 && isEmailVoice(value)) {
        messageVoice[kind] = value;
      }
    }
  }

  // MATCHING (Settings → Matching) — every knob in lib/match.ts::MatchConfig.
  // Rejected loudly rather than coerced: these decide who receives a real
  // customer's order, so a typo should stop the save, not quietly re-rank every
  // future match. Defaults mirror DEFAULT_MATCH_CONFIG and the migration's
  // column defaults, so an older client omitting them saves the rest unchanged.
  //
  // Ring edges are validated as a WHOLE ladder (ascending, positive, non-empty),
  // matching parseRingEdges — a half-valid ladder mis-buckets every candidate.
  let ringEdges: number[] = [5, 10, 20];
  if (match_ring_edges_km != null) {
    if (!Array.isArray(match_ring_edges_km) || match_ring_edges_km.length === 0) {
      return jsonError("Ring edges must be a non-empty list of distances in km.", 400);
    }
    const edges = (match_ring_edges_km as unknown[]).map((e) => Number(e));
    if (!edges.every((e) => Number.isFinite(e) && e > 0)) {
      return jsonError("Every ring edge must be a positive number of km.", 400);
    }
    for (let i = 1; i < edges.length; i++) {
      if (edges[i] <= edges[i - 1]) return jsonError("Ring edges must increase — e.g. 5, 10, 20.", 400);
    }
    // The last edge is the hard cap. 200km is a sanity rail, not policy: beyond
    // it the bounding-box prefilter stops being selective enough to be useful.
    if (edges[edges.length - 1] > 200) return jsonError("The largest ring edge (the distance cap) must be 200km or less.", 400);
    ringEdges = edges;
  }

  const matchWeights: Record<string, number> = {};
  for (const [key, raw, dflt] of [
    ["match_weight_distance", match_weight_distance, 0.25],
    ["match_weight_onboarded", match_weight_onboarded, 3.0],
    ["match_weight_emailable", match_weight_emailable, 1.5],
    ["match_weight_quality", match_weight_quality, 1.0],
    ["match_weight_source", match_weight_source, 1.2],
    ["match_weight_tier", match_weight_tier, 1.0],
    ["match_weight_performance", match_weight_performance, 0.4],
  ] as [string, unknown, number][]) {
    const n = raw == null ? dflt : Number(raw);
    // Negative weights would invert a term's meaning (a "quality" weight of −1
    // would rank the worst shops first), so the floor is 0.
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return jsonError(`${key.replace("match_weight_", "")} weight must be between 0 and 100.`, 400);
    }
    matchWeights[key] = n;
  }

  const topN = match_top_n == null ? 3 : Number(match_top_n);
  if (!Number.isInteger(topN) || topN < 1 || topN > 25) {
    return jsonError("Candidates per match must be a whole number between 1 and 25.", 400);
  }

  // The wave ceiling. Floor of 1 = one wave then escalate (the pre-refill
  // behavior); there is no "zero waves" that makes sense. The ceiling of 20 is
  // a sanity rail: 20 × topN is already the whole of most cities.
  const maxWaves = match_max_waves == null ? 4 : Number(match_max_waves);
  if (!Number.isInteger(maxWaves) || maxWaves < 1 || maxWaves > 20) {
    return jsonError("Maximum offer waves must be a whole number between 1 and 20.", 400);
  }

  // The quality floors: null is a meaningful value ("no floor"), distinct from 0.
  const minRating = match_min_rating == null || match_min_rating === "" ? null : Number(match_min_rating);
  if (minRating != null && (!Number.isFinite(minRating) || minRating < 0 || minRating > 5)) {
    return jsonError("Minimum rating must be between 0 and 5, or empty for no floor.", 400);
  }
  const minReviews = match_min_review_count == null || match_min_review_count === "" ? null : Number(match_min_review_count);
  if (minReviews != null && (!Number.isInteger(minReviews) || minReviews < 0)) {
    return jsonError("Minimum reviews must be a whole number of 0 or more, or empty for no floor.", 400);
  }

  const matching = {
    match_ring_edges_km: ringEdges,
    ...matchWeights,
    match_top_n: topN,
    match_max_waves: maxWaves,
    match_min_rating: minRating,
    match_min_review_count: minReviews,
    match_allow_unrated: boolOrDefault(match_allow_unrated, true),
    match_exclude_tier4: boolOrDefault(match_exclude_tier4, false),
    // Defaults TRUE: a florist with no trust tier has no payout split, so
    // letting an omitted field turn this off would route real orders to shops
    // we cannot pay.
    match_require_trust_tier: boolOrDefault(match_require_trust_tier, true),
  };

  // OUTREACH switches. Every boolean defaults FALSE, unlike the email toggles
  // above which default true: an omitted or malformed field here must never
  // START a funnel, offer a real order to an unvetted shop, or let a model reply
  // to a stranger. Same fail-closed reasoning as the SMS toggles.
  //
  // The numbers are clamped rather than rejected. This is a full-form overwrite,
  // so a 400 on one out-of-range box would discard every other edit on the page;
  // clamping keeps the save and lands on a value that is at least safe. Each
  // range is a sanity rail: a negative cap would mean "never send", and a
  // confidence outside 0–1 can't be compared against anything the model returns.
  const clamp = (v: unknown, dflt: number, lo: number, hi: number): number => {
    const n = v == null || v === "" ? dflt : Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  /** The daily send cap is the one setting with a genuine "no ceiling" state,
   * so it cannot go through `clamp` — every other numeric setting collapses
   * null to its default, which is exactly the collapse this field must not do.
   *
   * Only an EXPLICIT null means unlimited. An omitted or unparseable value
   * falls back to the bounded default: a malformed request is not an
   * instruction to send without limit. 0 survives as the kill switch.
   *
   * The finite ceiling is 100,000 rather than the old 5,000 because a capped
   * value should be able to express a real campaign day — 5,000 was itself a
   * limit someone would have had to come back and raise. */
  const dailySendCap = (v: unknown): number | null => {
    if (v === null) return null;
    if (v === undefined || v === "") return 200;
    const n = Number(v);
    if (!Number.isFinite(n)) return 200;
    return Math.round(Math.min(100_000, Math.max(0, n)));
  };
  const outreach = {
    // Sidebar decluttering only — see OPERATOR_HIDDEN in StaffShell.
    operator_view: boolOrDefault(operator_view, false),
    sequence_enabled: boolOrDefault(sequence_enabled, false),
    sequence_auto_enrol_scraped: boolOrDefault(sequence_auto_enrol_scraped, false),
    sequence_min_gap_hours: Math.round(clamp(sequence_min_gap_hours, 48, 0, 720)),
    sequence_daily_send_cap: dailySendCap(sequence_daily_send_cap),
    cold_offer_enabled: boolOrDefault(cold_offer_enabled, false),
    cold_offer_max_payout_eur: clamp(cold_offer_max_payout_eur, 120, 0, 10000),
    cold_offer_auto_payout_cap_eur: clamp(cold_offer_auto_payout_cap_eur, 90, 0, 10000),
    cold_offer_default_radius_km: clamp(cold_offer_default_radius_km, 12, 1, 200),
    cx_agent_enabled: boolOrDefault(cx_agent_enabled, false),
    support_agent_enabled: boolOrDefault(support_agent_enabled, false),
    // Widget visibility, not agent behavior — defaults TRUE (opposite of the
    // switches above) because the chat already rendered unconditionally
    // before this flag existed; an omitted/malformed field must never hide it.
    florist_chat_enabled: boolOrDefault(florist_chat_enabled, true),
    cx_agent_min_confidence: clamp(cx_agent_min_confidence, 0.75, 0, 1),
    cx_agent_max_auto_turns: Math.round(clamp(cx_agent_max_auto_turns, 3, 0, 20)),
  };

  // Service-role write (RLS has no update policy on app_settings). Auth-gated above.
  const admin = createServiceClient();
  const { error } = await admin
    .from("app_settings")
    .update({
      test_mode, test_email: email, test_phone: phone, workflow_mode: mode, cx_email: cx, florist_support_email: floristSupport,
      payments_paused: !!payments_paused,
      hold_delivery_payouts: hold_delivery_payouts == null ? false : !!hold_delivery_payouts,
      shopify_writeback_enabled: !!shopify_writeback_enabled,
      default_payout_percent: payoutPercent,
      active_order_tags: activeOrderTags,
      active_order_countries: activeOrderCountries,
      run_all_orders: runAllOrders,
      working_set_radius_km: radiusKm,
      ...emailToggles,
      offer_parallel_sends: parallelSends,
      ...ints,
      ...smsToggles,
      ...matching,
      stats_chat_model: statsChatModel,
      test_shop_matching: testShopMatching,
      message_voice: messageVoice,
      ...outreach,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) return jsonError(`Failed to save settings: ${error.message}`, 500);
  return Response.json({ ok: true });
}
