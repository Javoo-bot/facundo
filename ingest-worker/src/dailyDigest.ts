// Daily automation digest: the scheduled send.
//
// Runs off the existing every-minute cron rather than its own Cron Trigger,
// because Cloudflare Cron Triggers are UTC-only. 08:00 Europe/Madrid is 06:00
// UTC in summer and 07:00 UTC in winter, so a fixed UTC cron would silently
// drift by an hour twice a year. Checking the local hour in code is what makes
// "08:00 Madrid" mean 08:00 Madrid all year.
//
// Because the cron fires every minute, the send is guarded three ways:
//   1. reportingPeriod() returns null at the weekend, so nothing goes out,
//   2. it only runs at or after SEND_HOUR local time, and
//   3. it does not run if `external_ops` already records a successful digest
//      for that reporting period.
// Together those make it once-per-weekday AND self-healing: if the 08:00 tick
// is missed (deploy, outage), the next tick that succeeds still sends.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient, logExternalOp } from "./db";
import { captureError } from "./monitor";
import {
  buildReport,
  localDayMapper,
  localHour,
  reportingPeriod,
  addDays,
  EMPTY_COHORT,
  WORKING_SET_EVENT_TYPES,
  type DigestPeriod,
  type ActivityStats,
  type CohortActivity,
  type NoOfferReason,
  type DigestReport,
  type OrderOutcome,
  type ProviderFailureRow,
} from "./digestMetrics";
import { stageFromEvidence, type StageId } from "./digestStages";
import { buildHtmlBody, buildSubject, buildTextBody, formatPeriod } from "./digestEmail";

const TIMEZONE = "Europe/Madrid";
const SEND_HOUR = 8;
const OPERATION = "daily_automation_digest";

/**
 * How many times a day the send may be attempted before giving up until
 * tomorrow. Without a cap, a persistent failure (a revoked Resend key, say)
 * would retry on all ~960 remaining ticks of the day and fill external_ops with
 * the same error.
 */
const MAX_ATTEMPTS_PER_DAY = 5;

/** PostgREST caps a select at 1000 rows; every fetch here pages explicitly. */
const PAGE_SIZE = 1000;

/**
 * Hard stop on paging. Hitting it means something is very wrong, and it THROWS
 * rather than returning a short list, because a silently truncated set produces
 * a wrong funnel that still looks plausible.
 */
const MAX_PAGES = 50;

export interface DigestResult {
  ran: boolean;
  reason?: string;
  period?: string;
  emailId?: string;
}

const skipped = (reason: string): DigestResult => ({ ran: false, reason });

async function fetchAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const from = pageIndex * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label} page ${pageIndex} failed: ${JSON.stringify(error)}`);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
  throw new Error(`${label} exceeded ${MAX_PAGES} pages, refusing to report on a truncated set`);
}

/**
 * Wide UTC bounds around a local day range.
 *
 * Deliberately over-fetches by a day on each side instead of computing exact
 * Madrid-midnight instants in UTC. Rows are then bucketed by their LOCAL day,
 * which is the classification that matters, so the only cost is a few extra
 * rows and there is no hand-rolled DST arithmetic anywhere in this file.
 */
function wideBounds(fromDay: string, toDay: string): { fromIso: string; toIso: string } {
  const [fy, fm, fd] = fromDay.split("-").map(Number);
  const [ty, tm, td] = toDay.split("-").map(Number);
  return {
    fromIso: new Date(Date.UTC(fy, fm - 1, fd - 1)).toISOString(),
    toIso: new Date(Date.UTC(ty, tm - 1, td + 2)).toISOString(),
  };
}

interface EventRow {
  order_id: string;
  type: string;
  actor: string | null;
  created_at: string;
  /** Only `outreach_sent` carries anything the digest reads: `via` is
   *  "auto" when the wave engine sent it and "manual" when a person did. */
  payload: { via?: string } | null;
}

/** The columns every order_events read in this file needs. */
const EVENT_COLUMNS = "order_id,type,actor,created_at,payload";

/** One candidate florist lined up for an order, with the cohort it belongs to. */
interface AssignmentLeg {
  order_id: string;
  status: string | null;
  delivered_at: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  /** supabase-js types an embedded row as either shape, so both are handled. */
  florists: { lifecycle_stage: string | null } | { lifecycle_stage: string | null }[] | null;
}

/** The lifecycle stage of an embedded florist row, whichever shape it arrives in. */
function lifecycleStage(row: { florists: AssignmentLeg["florists"] }): string | null {
  const f = row.florists;
  return Array.isArray(f) ? f[0]?.lifecycle_stage ?? null : f?.lifecycle_stage ?? null;
}

/**
 * Why an order that was matched never had an offer sent.
 *
 * Derived, never stored, from the only three things that can be true of it:
 * it is off the happy path and a person owns it; every shop we lined up is a
 * stranger the wave engine may not contact unattended; or it could have been
 * sent automatically and has not been yet.
 *
 * `escalated` is checked FIRST because it is an overlay on the stage, not a
 * position in it: an escalated order might also have only new shops nearby,
 * and "a person already owns this" is the more useful of the two facts.
 */
export function noOfferReason(status: string, legs: { florists: AssignmentLeg["florists"] }[]): NoOfferReason {
  if (status === "escalated") return "other";
  if (legs.length === 0) return "other";
  const anyNetwork = legs.some((l) => {
    const stage = lifecycleStage(l);
    return stage === "production" || stage === "onboarding";
  });
  return anyNetwork ? "notSentYet" : "newShopsOnly";
}

/**
 * Every order that entered the working set between `fromDay` and `toDay`
 * inclusive, with the outcome it has reached.
 *
 * Volume here is tiny by design: the working set is a hand-picked list (38
 * orders over 14 days in production), so the per-order follow-up queries below
 * are a handful of `in(...)` lookups rather than a table scan.
 */
async function fetchOutcomes(
  sb: SupabaseClient,
  fromDay: string,
  toDay: string,
  staffEmails: Set<string>,
): Promise<OrderOutcome[]> {
  const bounds = wideBounds(fromDay, toDay);
  const toLocalDay = localDayMapper(TIMEZONE);

  // Candidate orders: anything CX either picked for the working set OR acted on
  // directly in the window. The second arm is not optional. On 2026-08-20 the
  // only order CX handled (#2000030: florist added, escalated, resolved,
  // outreach sent, all by one staff member) was never added to the working set,
  // so a worklist-only query reported that day as completely empty.
  const staffList = [...staffEmails];
  const [pickedEvents, staffEvents] = await Promise.all([
    fetchAllPages<EventRow>("worklist_added", (from, to) =>
      sb
        .from("order_events")
        .select(EVENT_COLUMNS)
        .eq("type", "worklist_added")
        .gte("created_at", bounds.fromIso)
        .lt("created_at", bounds.toIso)
        .range(from, to),
    ),
    staffList.length === 0
      ? Promise.resolve([])
      : fetchAllPages<EventRow>("staff-handled", (from, to) =>
          sb
            .from("order_events")
            .select(EVENT_COLUMNS)
            .in("actor", staffList)
            .not("type", "in", `(${[...WORKING_SET_EVENT_TYPES].join(",")})`)
            .gte("created_at", bounds.fromIso)
            .lt("created_at", bounds.toIso)
            .range(from, to),
        ),
  ]);

  const candidateIds = [...new Set([...pickedEvents, ...staffEvents].map((e) => e.order_id))];
  if (candidateIds.length === 0) return [];

  const [orders, assignments, events] = await Promise.all([
    fetchAllPages<{ id: string; status: string | null; delivery_at: string | null; is_demo: boolean | null; deleted_at: string | null }>(
      "orders",
      (from, to) =>
        sb.from("orders").select("id,status,delivery_at,is_demo,deleted_at").in("id", candidateIds).range(from, to),
    ),
    // `florists(lifecycle_stage)` is what makes "why did no offer go out?"
    // answerable. Without it the digest could say six orders stopped at
    // Matched but not that every shop we lined up for them was outside the
    // network, which is the difference between an automation problem and a
    // coverage problem. Same field, same meaning as fetchActivity's cohort
    // split and dashboard/lib/waves.ts's send gate.
    fetchAllPages<AssignmentLeg>(
      "order_assignments",
      (from, to) =>
        sb.from("order_assignments")
          .select("order_id,status,delivered_at,sent_at,accepted_at,florists(lifecycle_stage)")
          .in("order_id", candidateIds).range(from, to),
    ),
    // EVERY event for these orders, not just the windowed ones: the entry
    // instant below must be the order's FIRST ever, or an order taken on two
    // weeks ago would re-enter today's cohort the next time staff touched it.
    fetchAllPages<EventRow>("order_events (history)", (from, to) =>
      sb.from("order_events").select(EVENT_COLUMNS).in("order_id", candidateIds).range(from, to),
    ),
  ]);

  /** When this order first became ours: picked for the working set, or first
   *  acted on by staff, whichever came first. */
  const isEntryEvent = (e: EventRow): boolean =>
    e.type === "worklist_added" ||
    (!WORKING_SET_EVENT_TYPES.has(e.type) && e.actor !== null && staffEmails.has(e.actor));

  const enteredAt = new Map<string, string>();
  for (const event of events) {
    if (!isEntryEvent(event)) continue;
    const existing = enteredAt.get(event.order_id);
    if (!existing || event.created_at < existing) enteredAt.set(event.order_id, event.created_at);
  }

  // Keep only orders whose FIRST entry falls inside the reported period, so
  // each order is counted once, on the day it became ours.
  const orderIds = candidateIds.filter((id) => {
    const entered = enteredAt.get(id);
    if (!entered) return false;
    const day = toLocalDay(entered);
    return day >= fromDay && day <= toDay;
  });
  if (orderIds.length === 0) return [];

  const orderById = new Map(orders.map((o) => [o.id, o]));

  return orderIds
    .filter((id) => {
      const order = orderById.get(id);
      // Demo orders drive the real code paths, so without this a sandbox run
      // would show up as flawless automation that never happened.
      return order && !order.deleted_at && !order.is_demo;
    })
    .map((id) => {
      const order = orderById.get(id)!;
      const entered = enteredAt.get(id)!;
      const mine = events.filter((e) => e.order_id === id);
      const legs = assignments.filter((a) => a.order_id === id);

      // Only events at or after the moment it entered, and never the
      // working-set bookkeeping itself -- see digestMetrics.ts's header.
      const isStaffAction = (e: EventRow): boolean =>
        e.created_at >= entered &&
        !WORKING_SET_EVENT_TYPES.has(e.type) &&
        e.actor !== null &&
        staffEmails.has(e.actor);
      const staffActions = mine.filter(isStaffAction).length;
      const staffTouched = staffActions > 0;

      const has = (type: string): boolean => mine.some((e) => e.type === type);
      const bySystem = (type: string): boolean =>
        mine.some((e) => e.type === type && (e.actor === null || e.actor.startsWith("system")));

      // What actually happened, regardless of who drove it.
      const reached = stageFromEvidence({
        matched: legs.length > 0,
        outreach: legs.some((l) => l.sent_at !== null),
        fulfilment: legs.some((l) => l.accepted_at !== null),
        delivery: order.status === "out_for_delivery" || has("status:out_for_delivery"),
        delivered: has("delivered_photo") || order.status === "delivered" || order.status === "paid",
      });

      // What the loop did unattended. `outreach` is the one that needs the
      // payload rather than the actor: dashboard/lib/reachoutSend.ts stamps
      // `via: "auto"` only when the wave engine called it, and every one of the
      // 733 outreach_sent rows in production to date says "manual".
      const aloneMatched = bySystem("matched") || bySystem("late_matched");
      const aloneOutreach =
        mine.some((e) => e.type === "outreach_sent" && e.payload?.via === "auto");
      // A florist accepting or photographing is the loop working as designed,
      // but only when it followed an offer the loop itself sent: an accept on a
      // leg CX assigned by hand is CX's doing, not the loop's.
      const aloneFulfilment = legs.some((l) => l.sent_at !== null && l.accepted_at !== null);
      const reachedAlone: StageId = stageFromEvidence({
        matched: aloneMatched,
        outreach: aloneOutreach,
        fulfilment: aloneFulfilment,
        delivery: false,
        delivered: has("delivered_photo") && bySystem("photo_verified"),
      });

      // `order_assignments.delivered_at` is null on most delivered legs in
      // production; the reliable stamp is the delivered_photo event. Using only
      // the former reported 7 on time and 0 late when the truth was 4 and 2.
      const deliveredAt =
        legs.map((l) => l.delivered_at).filter((d): d is string => !!d).sort().at(-1) ??
        mine.filter((e) => e.type === "delivered_photo").map((e) => e.created_at).sort().at(-1) ??
        null;

      const status = order.status ?? "unknown";

      return {
        orderId: id,
        status,
        staffTouched,
        reached,
        reachedAlone,
        staffActions,
        // Only meaningful for an order that got no further than Matched; every
        // other order carries null so the breakdown cannot count it twice.
        noOfferReason: reached === "matched" ? noOfferReason(status, legs) : null,
        deliveredAt,
        dueAt: order.delivery_at,
        candidates: legs.length,
        expired: legs.filter((l) => l.status === "expired").length,
        declined: legs.filter((l) => l.status === "declined").length,
      };
    });
}

/** The staff allow list: who counts as "a human had to step in". */
async function fetchStaffEmails(sb: SupabaseClient): Promise<Set<string>> {
  const rows = await fetchAllPages<{ email: string }>("allowed emails", (from, to) =>
    sb.from("allowed_emails").select("email").range(from, to),
  );
  return new Set(rows.map((r) => r.email));
}

export interface AssignmentRow {
  order_id: string;
  florist_id: string;
  status: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  florists: { lifecycle_stage: string | null } | { lifecycle_stage: string | null }[] | null;
}

/** Shops that had already joined the network when the offer went out.
 *
 *  Deliberately the SAME predicate as dashboard/lib/waves.ts's `candOnboarded`,
 *  which is what decides whether the wave engine may send an offer without
 *  asking a human. Keeping one definition means the metric can never say a shop
 *  is in the network while the engine treats it as a stranger. */
function isNetworkShop(row: AssignmentRow): boolean {
  const f = row.florists;
  const stage = Array.isArray(f) ? f[0]?.lifecycle_stage ?? null : f?.lifecycle_stage ?? null;
  return stage === "production" || stage === "onboarding";
}

/**
 * One cohort, counted as a COHORT: the offers sent in the period, and what has
 * become of those same offers.
 *
 * Each offer's outcome is read off the offer itself, so `accepted` and
 * `answered` are always subsets of `offersSent`. The old version compared
 * offers sent in the period against replies received in the period, which are
 * different sets of rows and produced "1 accepted out of 0 sent". See
 * digestMetrics.ts::CohortActivity.
 */
export function tally(sent: AssignmentRow[]): CohortActivity {
  const accepted = sent.filter((a) => a.accepted_at !== null);
  const refused = sent.filter((a) => a.declined_at !== null);
  // The window closed and they never replied either way. Read off the offer's
  // own status so it stays a strict subset of `offersSent`, like the others.
  const timedOut = sent.filter((a) => a.status === "expired" && a.accepted_at === null && a.declined_at === null);
  return {
    offersSent: sent.length,
    answered: accepted.length + refused.length,
    accepted: accepted.length,
    timedOut: timedOut.length,
  };
}

/**
 * Offer activity IN the period, split by who the florist is.
 *
 * Counted on a different basis from the funnel: this is what happened on the
 * wire, so an offer sent last week and accepted yesterday counts as accepted
 * yesterday. Three narrow queries rather than one wide one, because an offer's
 * sent/accepted/declined stamps can each fall in different periods.
 *
 * The trailing window exists because a single day routinely puts one or two
 * offers in front of network shops: on 2026-08-26 that column was 2 offers, 2
 * accepted, and "100%" of two is not a number anybody should act on. The
 * 7-day figure beside it (4 of 7) is.
 */
async function fetchActivity(
  sb: SupabaseClient,
  fromDay: string,
  toDay: string,
): Promise<ActivityStats> {
  const bounds = wideBounds(fromDay, toDay);
  const toLocalDay = localDayMapper(TIMEZONE);
  const within = (iso: string | null, from: string): boolean => {
    if (!iso) return false;
    const day = toLocalDay(iso);
    return day >= from && day <= toDay;
  };

  // The embedded !inner joins are what keep the /testing sandbox out of these
  // numbers. Without the orders one a demo run lands squarely in the KPIs: on
  // 2026-08-14 the sandbox sent 10 offers and had several accepted and
  // delivered, which would have been reported as a real day's work. The
  // florists one carries the lifecycle_stage the cohort split reads, and
  // excludes shops flagged as test rigs.
  // One string literal, deliberately: supabase-js infers the row shape from the
  // literal, and splitting it across a `+` degrades the result to
  // GenericStringError[] and fails the build.
  const COLUMNS = "order_id,florist_id,status,sent_at,accepted_at,declined_at,decline_reason,orders!inner(is_demo,deleted_at),florists!inner(lifecycle_stage,is_test_shop)";
  const window = (column: string) => (from: number, to: number) =>
    sb.from("order_assignments").select(COLUMNS)
      .gte(column, bounds.fromIso).lt(column, bounds.toIso)
      .is("orders.deleted_at", null)
      .or("is_demo.is.null,is_demo.eq.false", { referencedTable: "orders" })
      .or("is_test_shop.is.null,is_test_shop.eq.false", { referencedTable: "florists" })
      .range(from, to);

  // Two queries, not three. The funnel per cohort reads each offer's outcome
  // off the offer itself, so only the offers SENT in the period are needed for
  // it. The declined-in-period query survives for one reason: the refusal
  // REASONS list, which is a tally of what florists said on the day they said
  // it, not a rate over any denominator.
  const [sentRows, declinedRows] = await Promise.all([
    fetchAllPages<AssignmentRow>("assignments (sent)", window("sent_at")),
    fetchAllPages<AssignmentRow>("assignments (declined)", window("declined_at")),
  ]);

  const sent = sentRows.filter((a) => within(a.sent_at, fromDay));
  const declined = declinedRows.filter((a) => within(a.declined_at, fromDay));

  const reasons = new Map<string, number>();
  for (const a of declined) {
    const reason = a.decline_reason?.trim() || "Not given";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  return {
    network: tally(sent.filter(isNetworkShop)),
    newShops: tally(sent.filter((a) => !isNetworkShop(a))),
    refusalReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

/**
 * Failed provider calls in the period, for digestMetrics.ts::providerOutages
 * to sort into "the account is down" versus "one recipient was rejected".
 * Same wide-UTC-then-local-day filtering as the other fetches, so a failure
 * just after local midnight lands on the right day.
 */
async function fetchProviderFailures(
  sb: SupabaseClient,
  fromDay: string,
  toDay: string,
): Promise<ProviderFailureRow[]> {
  const bounds = wideBounds(fromDay, toDay);
  const toLocalDay = localDayMapper(TIMEZONE);
  const rows = await fetchAllPages<ProviderFailureRow>("provider failures", (from, to) =>
    sb.from("external_ops").select("provider,error,created_at")
      .eq("ok", false)
      .in("provider", ["telnyx"])
      .gte("created_at", bounds.fromIso).lt("created_at", bounds.toIso)
      .range(from, to),
  );
  return rows.filter((r) => {
    const day = toLocalDay(r.created_at);
    return day >= fromDay && day <= toDay;
  });
}

export async function buildDigest(sb: SupabaseClient, period: DigestPeriod): Promise<DigestReport> {
  const staffEmails = await fetchStaffEmails(sb);

  const [outcomes, activity, providerFailures] = await Promise.all([
    fetchOutcomes(sb, period.fromDay, period.toDay, staffEmails),
    fetchActivity(sb, period.fromDay, period.toDay),
    fetchProviderFailures(sb, period.fromDay, period.toDay),
  ]);

  return buildReport({ period, outcomes, activity, providerFailures });
}

async function sendViaResend(args: {
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}): Promise<string> {
  // Resend, directly. Deliberately NOT the dashboard's sendEmail helper, which
  // falls back to Ongage on a Resend 429: there is no Ongage path here at all,
  // so a Resend rejection fails the run instead of quietly changing provider.
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: args.from, to: args.to, subject: args.subject, text: args.text, html: args.html,
    }),
  });
  const payload = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!response.ok) {
    throw new Error(`Resend rejected the send (${response.status}): ${payload?.message ?? "no detail"}`);
  }
  return payload?.id ?? "unknown";
}

function recipients(env: { DIGEST_TO?: string }): string[] {
  const configured = (env.DIGEST_TO ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_RECIPIENTS;
}

/**
 * Default recipients when DIGEST_TO is unset on the Worker.
 *
 * The format was signed off on 2026-08-21, so the wider CX list is back on.
 * It was held at one address while the layout was still changing, on the view
 * that a daily mail whose shape moves under the reader is worse than no mail.
 * Two more addresses were added on 2026-08-31 with the funnel rework.
 *
 * DIGEST_TO on the Worker overrides this entirely and needs no deploy, so use
 * that for a quick change and keep this list as the documented default.
 */
export const DEFAULT_RECIPIENTS = [
  "owner@fc.example.com",
  "marketing@fc.example.com",
  "editor@fc.example.com",
  "ops2@fc.example.com",
  "staff@fc.example.com",
];

export interface DigestEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RESEND_API_KEY?: string;
  DIGEST_TO?: string;
  DIGEST_FROM?: string;
  /** "true" bypasses the hour gate, the weekend gate and the dedupe. QA only. */
  DIGEST_FORCE?: string;
  /**
   * Send ONE more copy of a period that has already gone out, to one address.
   * A period key, `YYYY-MM-DD..YYYY-MM-DD`, optionally with a `@tag` suffix so
   * the same period can be previewed again after a change. See sendDigestReplay.
   */
  DIGEST_REPLAY?: string;
  /** Who the replay goes to. Required: no address, no replay. */
  DIGEST_REPLAY_TO?: string;
}

/** The external_ops operation a replay records itself under. */
const REPLAY_OPERATION = "daily_automation_digest_replay";

/**
 * A period key back into the period it names, or null if it is not one.
 *
 * Deliberately strict. This value decides which days get reported, and a
 * half-parsed key would produce a confident email about the wrong dates.
 */
export function parseReplayPeriod(key: string, timezone: string): DigestPeriod | null {
  // The optional `@tag` is what makes a SECOND preview of the same days
  // possible: the dedupe is keyed on the whole string, so changing the tag
  // permits exactly one more send, while leaving the value alone stays inert.
  // Without it the only way to re-preview a day after a wording change would
  // be DIGEST_FORCE, which is the every-minute mail this function exists to
  // avoid.
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})(?:@[\w.-]{1,32})?$/.exec(key.trim());
  if (!match) return null;
  const [, fromDay, toDay] = match;
  if (toDay < fromDay) return null;
  return { fromDay, toDay, timezone };
}

/**
 * One extra copy of an already-sent period, to a single address.
 *
 * WHY THIS EXISTS AND `DIGEST_FORCE` DOES NOT DO IT. The cron ticks every
 * minute, and force bypasses the dedupe, so leaving it on sends an email a
 * minute to the whole CX list until somebody notices. That is not a knob to
 * hand anyone for a one-off. This has its own dedupe key, so it sends EXACTLY
 * ONCE per period however many ticks pass and however long the vars stay set:
 * setting them is safe, forgetting to unset them is safe.
 *
 * Two more guards, both deliberate:
 *   the recipient is `DIGEST_REPLAY_TO` and never the daily list, so a replay
 *   cannot surprise the team with a second copy of a mail they already read;
 *   nothing is written under the daily operation, so the morning send's own
 *   dedupe and attempt cap are untouched.
 *
 * The report is built from state as it is NOW, not as it was at 08:00, so a
 * replay of an earlier day can legitimately differ from what went out then.
 * That is the point when the reason for the replay is a format change.
 */
export async function sendDigestReplay(env: DigestEnv): Promise<DigestResult> {
  if (!env.DIGEST_REPLAY) return skipped("replay-unset");
  if (!env.RESEND_API_KEY) return skipped("resend-key-unset");

  const to = (env.DIGEST_REPLAY_TO ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (to.length === 0) return skipped("replay-no-recipient");

  const period = parseReplayPeriod(env.DIGEST_REPLAY, TIMEZONE);
  if (!period) return skipped("replay-bad-period");

  const periodKey = `${period.fromDay}..${period.toDay}`;
  // Dedupe on the RAW value, tag and all, not on the days it resolves to.
  const replayKey = env.DIGEST_REPLAY.trim();
  const sb = createServiceClient(env);

  try {
    const { data: prior, error: priorError } = await sb
      .from("external_ops")
      .select("ok")
      .eq("provider", "resend")
      .eq("operation", REPLAY_OPERATION)
      .eq("meta->>replayKey", replayKey);
    if (priorError) throw new Error(`replay dedupe lookup failed: ${JSON.stringify(priorError)}`);

    const attempts = prior ?? [];
    if (attempts.some((a) => a.ok === true)) return skipped("replay-already-sent");
    // The same cap the daily send uses, for the same reason: a persistent
    // failure must not retry on all ~960 remaining ticks of the day.
    if (attempts.length >= MAX_ATTEMPTS_PER_DAY) return skipped("replay-attempt-cap-reached");

    const report = await buildDigest(sb, period);
    console.log(`[digest] replay ${replayKey} takenIn=${report.takenIn} to=${to.join(",")}`);

    const emailId = await sendViaResend({
      apiKey: env.RESEND_API_KEY,
      from: env.DIGEST_FROM ?? "Facundo Automation <automation@fc.example.net>",
      to,
      subject: buildSubject(report),
      text: buildTextBody(report),
      html: buildHtmlBody(report),
    });

    await logExternalOp(sb, {
      provider: "resend", operation: REPLAY_OPERATION, direction: "out",
      orderId: null, ref: emailId, ok: true, error: null,
      meta: { replayKey, period: periodKey, to, takenIn: report.takenIn },
    });

    return { ran: true, period: formatPeriod(period), emailId };
  } catch (e) {
    captureError("cron.daily_digest_replay", e);
    await logExternalOp(sb, {
      provider: "resend", operation: REPLAY_OPERATION, direction: "out",
      orderId: null, ref: null, ok: false,
      error: e instanceof Error ? e.message : String(e),
      meta: { replayKey, period: periodKey },
    });
    return skipped("replay-error");
  }
}

/**
 * Send the funnel for the current reporting period, if it is time and it has
 * not gone out yet.
 *
 * Never throws: it shares an invocation with the ingest cron, and a reporting
 * email must never be the thing that breaks order automation. Failures are
 * captured and recorded in external_ops instead.
 */
export async function sendDailyDigest(
  env: DigestEnv,
  opts: { force?: boolean; now?: Date } = {},
): Promise<DigestResult> {
  const now = opts.now ?? new Date();
  const force = opts.force ?? env.DIGEST_FORCE === "true";

  if (!env.RESEND_API_KEY) return skipped("resend-key-unset");
  const to = recipients(env);

  const period = reportingPeriod(now, TIMEZONE);
  // Weekend: nobody reads it, and Monday's run covers Friday to Sunday.
  if (!period) return skipped("weekend");
  if (!force && localHour(now, TIMEZONE) < SEND_HOUR) return skipped("before-send-hour");

  const periodKey = `${period.fromDay}..${period.toDay}`;
  const sb = createServiceClient(env);

  try {
    const { data: priorAttempts, error: priorError } = await sb
      .from("external_ops")
      .select("ok")
      .eq("provider", "resend")
      .eq("operation", OPERATION)
      .eq("meta->>period", periodKey);
    if (priorError) throw new Error(`dedupe lookup failed: ${JSON.stringify(priorError)}`);

    const attempts = priorAttempts ?? [];
    if (!force && attempts.some((a) => a.ok === true)) return skipped("already-sent");
    if (!force && attempts.length >= MAX_ATTEMPTS_PER_DAY) return skipped("attempt-cap-reached");

    const report = await buildDigest(sb, period);

    // Logged before the send so the numbers survive in the Worker log even if
    // every Resend retry fails.
    console.log(
      `[digest] ${periodKey} takenIn=${report.takenIn} alone=${report.automation.alone.stage} ` +
        `reached=${report.automation.reached.stage} neverMoved=${report.automation.neverMoved} ` +
        `delivered=${report.delivered} escalated=${report.escalated}`,
    );

    const emailId = await sendViaResend({
      apiKey: env.RESEND_API_KEY,
      // fc.example.net is the verified sending domain on the Resend account, so
      // this default delivers as-is.
      from: env.DIGEST_FROM ?? "Facundo Automation <automation@fc.example.net>",
      to,
      subject: buildSubject(report),
      text: buildTextBody(report),
      html: buildHtmlBody(report),
    });

    await logExternalOp(sb, {
      provider: "resend", operation: OPERATION, direction: "out",
      orderId: null, ref: emailId, ok: true, error: null,
      meta: {
        period: periodKey,
        to,
        takenIn: report.takenIn,
        aloneStage: report.automation.alone.stage,
        reachedStage: report.automation.reached.stage,
        neverMoved: report.automation.neverMoved,
        delivered: report.delivered,
        escalated: report.escalated,
      },
    });

    return { ran: true, period: formatPeriod(period), emailId };
  } catch (e) {
    captureError("cron.daily_digest", e);
    await logExternalOp(sb, {
      provider: "resend", operation: OPERATION, direction: "out",
      orderId: null, ref: null, ok: false,
      error: e instanceof Error ? e.message : String(e),
      meta: { period: periodKey },
    });
    return skipped("error");
  }
}
